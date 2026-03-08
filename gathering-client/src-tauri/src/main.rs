// Gathering native client — Tauri 2 wrapper

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod midi;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(midi::MidiState::new())
        .invoke_handler(tauri::generate_handler![
            midi::midi_list_ports,
            midi::midi_connect,
            midi::midi_disconnect,
        ])
        .setup(|app| {
            // Accept self-signed TLS certificates (common for self-hosted servers)
            #[cfg(target_os = "linux")]
            {
                let window = app.get_webview_window("main").unwrap();
                window.with_webview(|webview| {
                    use webkit2gtk::{WebViewExt, WebContextExt};

                    let wv = webview.inner();

                    // Accept self-signed TLS certificates
                    let ctx: webkit2gtk::WebContext = wv.web_context().unwrap();
                    ctx.set_tls_errors_policy(webkit2gtk::TLSErrorsPolicy::Ignore);

                    // Auto-grant microphone/camera permission requests for voice chat
                    unsafe {
                        use glib::object::ObjectExt;
                        use glib::ToValue;
                        wv.connect_unsafe(
                            "permission-request",
                            false,
                            |values| {
                                use webkit2gtk::PermissionRequestExt;
                                let req = values[1].get::<webkit2gtk::PermissionRequest>().unwrap();
                                req.allow();
                                Some(true.to_value())
                            },
                        );
                    }
                }).ok();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Gathering");
}
