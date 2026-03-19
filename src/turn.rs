use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use tokio::net::UdpSocket;
use turn::auth::LongTermAuthHandler;
use turn::relay::relay_range::RelayAddressGeneratorRanges;
use turn::server::config::{ConnConfig, ServerConfig as TurnServerConfig};
use turn::server::Server;
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

/// Start the embedded TURN server on the given UDP port.
///
/// `public_address` is the externally-visible IP/hostname.
/// Relay candidates advertise the resolved public IP so that external peers
/// can route to them.  LAN clients use host candidates for direct connectivity
/// and fall back to the LAN ICE server entries if needed.
pub async fn start_turn_server(
    public_address: &str,
    turn_port: u16,
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

    // Always use public_ip as the relay address so that relay candidates contain
    // a routable address for external clients.  LAN clients rarely need TURN
    // (host candidates work) and can fall back to the LAN ICE server entries.
    // Using the LAN IP here would produce relay candidates like 192.168.x.x
    // that external peers cannot reach.
    let relay_ip = public_ip;

    let conn = Arc::new(UdpSocket::bind(format!("0.0.0.0:{}", turn_port)).await?);

    let server = Server::new(TurnServerConfig {
        conn_configs: vec![ConnConfig {
            conn,
            relay_addr_generator: Box::new(RelayAddressGeneratorRanges {
                relay_address: relay_ip,
                min_port: relay_port_min,
                max_port: relay_port_max,
                max_retries: 10,
                address: "0.0.0.0".to_owned(),
                net: Arc::new(Net::new(None)),
            }),
        }],
        realm: TURN_REALM.to_owned(),
        auth_handler: Arc::new(LongTermAuthHandler::new(shared_secret.to_string())),
        channel_bind_timeout: Duration::from_secs(0), // use default
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
/// No packets are actually sent — this just lets the OS pick the right source interface.
pub fn detect_lan_ip() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let local_ip = socket.local_addr().ok()?.ip();
    // Only return if it's a private/LAN address
    match local_ip {
        IpAddr::V4(v4) if v4.is_private() => Some(local_ip),
        _ => None,
    }
}

/// Build the ICE server list for a client (STUN + TURN entries).
/// Includes both public and LAN addresses so connections work regardless of
/// whether the client is inside or outside the network (hairpin NAT workaround).
pub fn build_ice_servers(
    public_address: &str,
    turn_port: u16,
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

    // Add LAN entries so clients on the same network can reach the TURN server
    // even when the router doesn't support hairpin NAT
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
        }
    }

    servers
}
