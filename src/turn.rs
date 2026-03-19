use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, Mutex, RwLock};
use turn::auth::LongTermAuthHandler;
use turn::relay::relay_range::RelayAddressGeneratorRanges;
use turn::server::config::{ConnConfig, ServerConfig as TurnServerConfig};
use turn::server::Server;
use webrtc_util::conn::Conn;
use webrtc_util::vnet::net::Net;

use crate::protocol::IceServer;

const TURN_REALM: &str = "gathering";
pub const DEFAULT_RELAY_MIN_PORT: u16 = 49152;
pub const DEFAULT_RELAY_MAX_PORT: u16 = 49252;
const CREDENTIAL_TTL_SECS: u64 = 86400; // 24 hours

/// Strip scheme (e.g. "https://") and port (e.g. ":9123") from a public_address
/// value, in case the user pastes a full URL instead of just a hostname/IP.
pub fn sanitize_public_address(raw: &str) -> String {
    let mut s = raw.trim();
    // Strip scheme
    if let Some(rest) = s.strip_prefix("https://") {
        s = rest;
    } else if let Some(rest) = s.strip_prefix("http://") {
        s = rest;
    }
    // Strip trailing path
    if let Some(idx) = s.find('/') {
        s = &s[..idx];
    }
    // Strip port suffix (but not if it's an IPv6 address like [::1]:3478)
    if !s.starts_with('[') {
        if let Some(idx) = s.rfind(':') {
            if s[idx + 1..].chars().all(|c| c.is_ascii_digit()) {
                s = &s[..idx];
            }
        }
    }
    s.to_string()
}

// ── TCP-to-datagram adapter for TURN over TCP ─────────────────────────

/// Bridges TCP connections to the TURN server's datagram-oriented Conn interface.
/// Accepts TCP clients, frames STUN/ChannelData messages per RFC 4571/5766,
/// and presents them as datagrams via recv_from/send_to.
struct TcpTurnMux {
    local_addr: SocketAddr,
    rx: Mutex<mpsc::UnboundedReceiver<(Vec<u8>, SocketAddr)>>,
    writers: RwLock<HashMap<SocketAddr, Arc<Mutex<tokio::net::tcp::OwnedWriteHalf>>>>,
    closed: AtomicBool,
}

impl TcpTurnMux {
    /// Bind a TCP listener and spawn the accept loop.
    async fn bind(addr: SocketAddr) -> std::io::Result<Arc<Self>> {
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let local_addr = listener.local_addr()?;
        let (tx, rx) = mpsc::unbounded_channel();

        let mux = Arc::new(Self {
            local_addr,
            rx: Mutex::new(rx),
            writers: RwLock::new(HashMap::new()),
            closed: AtomicBool::new(false),
        });

        let mux2 = Arc::clone(&mux);
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, peer_addr)) => {
                        let tx2 = tx.clone();
                        let mux3 = Arc::clone(&mux2);
                        tokio::spawn(async move {
                            mux3.handle_tcp_client(stream, peer_addr, tx2).await;
                        });
                    }
                    Err(e) => {
                        if mux2.closed.load(Ordering::Relaxed) {
                            break;
                        }
                        tracing::warn!("TURN TCP accept error: {}", e);
                    }
                }
            }
        });

        Ok(mux)
    }

    async fn handle_tcp_client(
        &self,
        stream: tokio::net::TcpStream,
        peer_addr: SocketAddr,
        tx: mpsc::UnboundedSender<(Vec<u8>, SocketAddr)>,
    ) {
        let (read_half, write_half) = stream.into_split();
        let write_half = Arc::new(Mutex::new(write_half));
        self.writers.write().await.insert(peer_addr, Arc::clone(&write_half));

        let mut reader = tokio::io::BufReader::new(read_half);
        loop {
            match read_turn_message(&mut reader).await {
                Ok(data) => {
                    if tx.send((data, peer_addr)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        self.writers.write().await.remove(&peer_addr);
    }
}

/// Read one STUN/TURN framed message from a TCP stream.
/// STUN messages (first 2 bits = 00): 20-byte header + length.
/// ChannelData (first 2 bits = 01): 4-byte header + length (padded to 4 bytes on TCP).
async fn read_turn_message<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Vec<u8>> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header).await?;

    let first_two_bits = header[0] >> 6;
    let length = u16::from_be_bytes([header[2], header[3]]) as usize;

    match first_two_bits {
        0b00 => {
            // STUN/TURN: 20-byte header + length bytes
            let total = 20 + length;
            let mut buf = vec![0u8; total];
            buf[..4].copy_from_slice(&header);
            if total > 4 {
                reader.read_exact(&mut buf[4..total]).await?;
            }
            Ok(buf)
        }
        0b01 => {
            // ChannelData: 4-byte header + length (read padding too)
            let padded = (length + 3) & !3;
            let read_total = 4 + padded;
            let mut buf = vec![0u8; read_total];
            buf[..4].copy_from_slice(&header);
            if padded > 0 {
                reader.read_exact(&mut buf[4..read_total]).await?;
            }
            buf.truncate(4 + length);
            Ok(buf)
        }
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid TURN/STUN TCP framing",
        )),
    }
}

#[async_trait]
impl Conn for TcpTurnMux {
    async fn connect(&self, _addr: SocketAddr) -> webrtc_util::Result<()> {
        Ok(())
    }

    async fn recv(&self, buf: &mut [u8]) -> webrtc_util::Result<usize> {
        let (n, _) = self.recv_from(buf).await?;
        Ok(n)
    }

    async fn recv_from(&self, buf: &mut [u8]) -> webrtc_util::Result<(usize, SocketAddr)> {
        let mut rx = self.rx.lock().await;
        match rx.recv().await {
            Some((data, addr)) => {
                let n = data.len().min(buf.len());
                buf[..n].copy_from_slice(&data[..n]);
                Ok((n, addr))
            }
            None => Err(webrtc_util::Error::ErrClosedListener),
        }
    }

    async fn send(&self, _buf: &[u8]) -> webrtc_util::Result<usize> {
        Err(webrtc_util::Error::ErrNoRemAddr)
    }

    async fn send_to(&self, buf: &[u8], target: SocketAddr) -> webrtc_util::Result<usize> {
        let writers = self.writers.read().await;
        if let Some(writer) = writers.get(&target) {
            let mut w = writer.lock().await;
            w.write_all(buf).await?;
            // Pad ChannelData to 4-byte boundary for TCP (RFC 5766 §11.5)
            if buf.len() >= 4 && (buf[0] >> 6) == 0b01 {
                let pad = (4 - (buf.len() % 4)) % 4;
                if pad > 0 {
                    w.write_all(&[0u8; 3][..pad]).await?;
                }
            }
            Ok(buf.len())
        } else {
            Err(webrtc_util::Error::ErrClosedListener)
        }
    }

    fn local_addr(&self) -> webrtc_util::Result<SocketAddr> {
        Ok(self.local_addr)
    }

    fn remote_addr(&self) -> Option<SocketAddr> {
        None
    }

    async fn close(&self) -> webrtc_util::Result<()> {
        self.closed.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn as_any(&self) -> &(dyn std::any::Any + Send + Sync) {
        self
    }
}

// ── TURN server startup ───────────────────────────────────────────────

/// Start the embedded TURN server.
///
/// `public_address` is the externally-visible IP/hostname.
/// Optional `turn_port_alt` adds a second UDP listener (e.g. 443 for mobile).
/// Optional `turn_tcp_port` adds a TCP listener for TURN-over-TCP.
pub async fn start_turn_server(
    public_address: &str,
    turn_port: u16,
    turn_port_alt: Option<u16>,
    turn_tcp_port: Option<u16>,
    shared_secret: &str,
    relay_port_min: u16,
    relay_port_max: u16,
) -> Result<Server, Box<dyn std::error::Error + Send + Sync>> {
    // Resolve public_address to IP
    let public_ip: IpAddr = if let Ok(ip) = public_address.parse::<IpAddr>() {
        ip
    } else {
        let addr = tokio::net::lookup_host(format!("{}:0", public_address))
            .await?
            .next()
            .ok_or("Failed to resolve public_address to IP")?;
        addr.ip()
    };

    let relay_ip = public_ip;

    let make_relay_gen = || -> Box<RelayAddressGeneratorRanges> {
        Box::new(RelayAddressGeneratorRanges {
            relay_address: relay_ip,
            min_port: relay_port_min,
            max_port: relay_port_max,
            max_retries: 10,
            address: "0.0.0.0".to_owned(),
            net: Arc::new(Net::new(None)),
        })
    };

    // Primary UDP listener
    let mut conn_configs = vec![ConnConfig {
        conn: Arc::new(UdpSocket::bind(format!("0.0.0.0:{}", turn_port)).await?),
        relay_addr_generator: make_relay_gen(),
    }];

    // Alternative UDP port (e.g. 443 for mobile carrier compat)
    if let Some(alt_port) = turn_port_alt {
        let conn = Arc::new(UdpSocket::bind(format!("0.0.0.0:{}", alt_port)).await?);
        tracing::info!("TURN alt UDP listener on port {}", alt_port);
        conn_configs.push(ConnConfig {
            conn,
            relay_addr_generator: make_relay_gen(),
        });
    }

    // TCP listener for TURN-over-TCP
    if let Some(tcp_port) = turn_tcp_port {
        let addr: SocketAddr = format!("0.0.0.0:{}", tcp_port).parse().unwrap();
        let tcp_conn = TcpTurnMux::bind(addr).await?;
        tracing::info!("TURN TCP listener on port {}", tcp_port);
        conn_configs.push(ConnConfig {
            conn: tcp_conn,
            relay_addr_generator: make_relay_gen(),
        });
    }

    let server = Server::new(TurnServerConfig {
        conn_configs,
        realm: TURN_REALM.to_owned(),
        auth_handler: Arc::new(LongTermAuthHandler::new(shared_secret.to_string())),
        channel_bind_timeout: Duration::from_secs(0),
        alloc_close_notify: None,
    })
    .await?;

    Ok(server)
}

/// Load or generate the shared TURN secret from `<data_dir>/turn_secret`.
pub fn load_or_generate_secret(data_dir: &Path) -> String {
    let secret_path = data_dir.join("turn_secret");
    if let Ok(secret) = std::fs::read_to_string(&secret_path) {
        let trimmed = secret.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("Failed to generate random bytes");
    let secret = base64::engine::general_purpose::STANDARD.encode(bytes);
    std::fs::write(&secret_path, &secret).expect("Failed to write TURN secret file");
    secret
}

/// Generate time-limited TURN credentials from the shared secret.
pub fn generate_credentials(shared_secret: &str) -> (String, String) {
    turn::auth::generate_long_term_credentials(
        shared_secret,
        Duration::from_secs(CREDENTIAL_TTL_SECS),
    )
    .expect("Failed to generate TURN credentials")
}

/// Detect the server's LAN IP by creating a UDP socket aimed at a public address.
pub fn detect_lan_ip() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let local_ip = socket.local_addr().ok()?.ip();
    match local_ip {
        IpAddr::V4(v4) if v4.is_private() => Some(local_ip),
        _ => None,
    }
}

/// Build the ICE server list for a client (STUN + TURN entries).
/// Includes public, LAN, alt-port, and TCP entries as configured.
pub fn build_ice_servers(
    public_address: &str,
    turn_port: u16,
    turn_port_alt: Option<u16>,
    turn_tcp_port: Option<u16>,
    username: &str,
    credential: &str,
    lan_ip: Option<IpAddr>,
) -> Vec<IceServer> {
    let mut servers = vec![
        IceServer {
            urls: vec![format!("stun:{}:{}", public_address, turn_port)],
            username: None,
            credential: None,
        },
        IceServer {
            urls: vec![format!("turn:{}:{}", public_address, turn_port)],
            username: Some(username.to_string()),
            credential: Some(credential.to_string()),
        },
    ];

    // Alt UDP port entries (e.g. 443 for mobile carrier compat)
    if let Some(alt_port) = turn_port_alt {
        servers.push(IceServer {
            urls: vec![format!("stun:{}:{}", public_address, alt_port)],
            username: None,
            credential: None,
        });
        servers.push(IceServer {
            urls: vec![format!("turn:{}:{}", public_address, alt_port)],
            username: Some(username.to_string()),
            credential: Some(credential.to_string()),
        });
    }

    // TCP TURN entry
    if let Some(tcp_port) = turn_tcp_port {
        servers.push(IceServer {
            urls: vec![format!("turn:{}:{}?transport=tcp", public_address, tcp_port)],
            username: Some(username.to_string()),
            credential: Some(credential.to_string()),
        });
    }

    // LAN entries for hairpin NAT workaround
    if let Some(lip) = lan_ip {
        let lip_str = lip.to_string();
        if lip_str != public_address {
            servers.push(IceServer {
                urls: vec![format!("stun:{}:{}", lip_str, turn_port)],
                username: None,
                credential: None,
            });
            servers.push(IceServer {
                urls: vec![format!("turn:{}:{}", lip_str, turn_port)],
                username: Some(username.to_string()),
                credential: Some(credential.to_string()),
            });

            if let Some(alt_port) = turn_port_alt {
                servers.push(IceServer {
                    urls: vec![format!("turn:{}:{}", lip_str, alt_port)],
                    username: Some(username.to_string()),
                    credential: Some(credential.to_string()),
                });
            }

            if let Some(tcp_port) = turn_tcp_port {
                servers.push(IceServer {
                    urls: vec![format!("turn:{}:{}?transport=tcp", lip_str, tcp_port)],
                    username: Some(username.to_string()),
                    credential: Some(credential.to_string()),
                });
            }
        }
    }

    servers
}
