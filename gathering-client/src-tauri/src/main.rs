// Gathering native client — Tauri 2 wrapper

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod midi;

use tauri::Manager;
use tauri::tray::TrayIconBuilder;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::image::Image;

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
            // ── System tray ──────────────────────────────────────
            let show = MenuItemBuilder::with_id("show", "Show Gathering").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&quit)
                .build()?;

            let icon = Image::from_path("icons/icon.png")
                .unwrap_or_else(|_| Image::from_bytes(include_bytes!("../icons/icon.png")).expect("embedded icon"));

            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Gathering")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ── Linux: accept self-signed TLS, auto-grant media permissions ──
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
