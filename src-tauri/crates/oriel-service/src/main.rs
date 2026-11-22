use std::net::SocketAddr;

fn port_from_env() -> u16 {
    std::env::var("ORIEL_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787)
}

fn main() {
    let port = port_from_env();
    let version = env!("CARGO_PKG_VERSION");
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    println!("oriel-service {version} listening on http://{addr}");
    if let Err(error) = runtime.block_on(oriel_service::serve(
        oriel_service::AppState::new(port, version),
        addr,
    )) {
        eprintln!("oriel-service stopped: {error}");
        std::process::exit(1);
    }
}
