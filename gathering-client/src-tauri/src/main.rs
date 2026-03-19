// Gathering native client — Tauri 2 wrapper

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod midi;

use tauri::Manager;
use tauri::tray::TrayIconBuilder;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::image::Image;
use std::sync::Mutex;

/// Track whether we have unread messages (set from JS via command)
struct UnreadState {
    has_unread: bool,
}

#[tauri::command]
fn set_unread_badge(state: tauri::State<'_, Mutex<UnreadState>>, tray: tauri::State<'_, TrayHandle>, has_unread: bool) {
    let mut s = state.lock().unwrap();
    if s.has_unread == has_unread { return; }
    s.has_unread = has_unread;

    let tooltip = if has_unread { "Gathering (new messages)" } else { "Gathering" };
    if let Some(tray_icon) = &*tray.0.lock().unwrap() {
        let _ = tray_icon.set_tooltip(Some(tooltip));
        // Change icon to indicate unread
        let icon = if has_unread {
            make_badge_icon()
        } else {
            load_normal_icon()
        };
        if let Some(icon) = icon {
            let _ = tray_icon.set_icon(Some(icon));
        }
    }
}

struct TrayHandle(Mutex<Option<tauri::tray::TrayIcon>>);

fn load_normal_icon() -> Option<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/icon.png")).ok()
}

/// Create a badge icon by compositing a red dot onto the normal icon
fn make_badge_icon() -> Option<Image<'static>> {
    let icon = Image::from_bytes(include_bytes!("../icons/icon.png")).ok()?;
    let width = icon.width();
    let height = icon.height();
    let mut rgba = icon.rgba().to_vec();

    // Draw a red circle in the top-right corner
    let dot_radius = (width.min(height) as f64 * 0.18) as i32;
    let cx = width as i32 - dot_radius - 2;
    let cy = dot_radius + 2;

    for y in 0..height as i32 {
        for x in 0..width as i32 {
            let dx = x - cx;
            let dy = y - cy;
            if dx * dx + dy * dy <= dot_radius * dot_radius {
                let idx = ((y as u32 * width + x as u32) * 4) as usize;
                if idx + 3 < rgba.len() {
                    rgba[idx] = 0xe7;     // R
                    rgba[idx + 1] = 0x4c; // G
                    rgba[idx + 2] = 0x3c; // B
                    rgba[idx + 3] = 0xff; // A
                }
            }
        }
    }

    Some(Image::new_owned(rgba, width, height))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(midi::MidiState::new())
        .manage(Mutex::new(UnreadState { has_unread: false }))
        .manage(TrayHandle(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            midi::midi_list_ports,
            midi::midi_connect,
            midi::midi_disconnect,
            set_unread_badge,
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

            let tray = TrayIconBuilder::new()
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

            // Store tray handle for badge updates
            *app.state::<TrayHandle>().0.lock().unwrap() = Some(tray);

            // ── Close to tray instead of quitting ────────────────
            let win = app.get_webview_window("main").unwrap();
            let win2 = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win2.hide();
                }
            });

            // ── Linux: accept self-signed TLS, enable WebRTC, auto-grant media permissions ──
            #[cfg(target_os = "linux")]
            {
                let window = app.get_webview_window("main").unwrap();
                window.with_webview(|webview| {
                    use webkit2gtk::{WebViewExt, WebContextExt, SettingsExt};
                    use glib::object::ObjectExt;

                    let wv = webview.inner();

                    // Accept self-signed TLS certificates
                    let ctx: webkit2gtk::WebContext = wv.web_context().unwrap();
                    ctx.set_tls_errors_policy(webkit2gtk::TLSErrorsPolicy::Ignore);

                    // Enable WebRTC and media stream (disabled by default in WebKitGTK)
                    if let Some(settings) = wv.settings() {
                        settings.set_enable_media_stream(true);
                        // enable-webrtc property (WebKitGTK 2.38+) — use GLib property
                        // API since the typed method may not be in the Rust bindings
                        settings.set_property("enable-webrtc", true);
                    }

                    // Auto-grant microphone/camera permission requests for voice chat
                    unsafe {
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
