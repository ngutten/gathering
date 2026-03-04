use std::net::IpAddr;
use std::path::Path;

/// Ensure TLS certificate and key exist, generating self-signed ones if needed.
pub fn ensure_tls(data_dir: &Path) {
    let cert_path = data_dir.join("cert.pem");
    let key_path = data_dir.join("key.pem");

    if cert_path.exists() && key_path.exists() {
        tracing::info!("TLS certificates found in {:?}", data_dir);
        return;
    }

    tracing::info!("Generating self-signed TLS certificate...");

    let san_names: Vec<String> = vec!["localhost".to_string()];
    let mut san_ips: Vec<IpAddr> = vec!["127.0.0.1".parse().unwrap()];

    // Detect local LAN IP via UDP socket trick
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip();
                if !san_ips.contains(&ip) {
                    tracing::info!("Detected local IP: {}, adding to certificate SANs", ip);
                    san_ips.push(ip);
                }
            }
        }
    }

    let mut params = rcgen::CertificateParams::new(san_names);
    for ip in san_ips {
        params.subject_alt_names.push(rcgen::SanType::IpAddress(ip));
    }

    let cert =
        rcgen::Certificate::from_params(params).expect("Failed to generate self-signed certificate");

    let cert_pem = cert.serialize_pem().expect("Failed to serialize certificate");
    let key_pem = cert.serialize_private_key_pem();

    std::fs::write(&cert_path, &cert_pem).expect("Failed to write cert.pem");
    std::fs::write(&key_path, &key_pem).expect("Failed to write key.pem");

    tracing::info!(
        "Self-signed TLS certificate written to {:?} (delete cert.pem & key.pem to regenerate)",
        data_dir
    );
}

/// Load TLS configuration from cert.pem and key.pem in the data directory.
pub async fn load_rustls_config(data_dir: &Path) -> axum_server::tls_rustls::RustlsConfig {
    let cert_path = data_dir.join("cert.pem");
    let key_path = data_dir.join("key.pem");

    axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert_path, &key_path)
        .await
        .expect("Failed to load TLS certificate/key")
}
