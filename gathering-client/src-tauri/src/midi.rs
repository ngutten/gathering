// Native MIDI bridge for Tauri — exposes MIDI input via midir
// when the Web MIDI API is unavailable (e.g. WebKitGTK on Linux).

use midir::{MidiInput, MidiInputConnection};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Holds the active MIDI connection (one at a time).
pub struct MidiState {
    connection: Mutex<Option<MidiInputConnection<()>>>,
}

impl MidiState {
    pub fn new() -> Self {
        Self {
            connection: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct MidiPort {
    index: usize,
    name: String,
}

#[derive(Serialize, Clone)]
struct MidiEvent {
    status: u8,
    note: u8,
    velocity: u8,
}

/// List available MIDI input ports.
#[tauri::command]
pub fn midi_list_ports() -> Result<Vec<MidiPort>, String> {
    let input = MidiInput::new("gathering-list").map_err(|e| e.to_string())?;
    let ports = input.ports();
    let mut result = Vec::new();
    for (i, port) in ports.iter().enumerate() {
        let name = input.port_name(port).unwrap_or_else(|_| format!("Port {}", i));
        result.push(MidiPort { index: i, name });
    }
    Ok(result)
}

/// Connect to a MIDI input port by name. Disconnects any previous connection.
/// Using name-based matching avoids port index instability between MidiInput instances.
#[tauri::command]
pub fn midi_connect(app: AppHandle, name: String) -> Result<String, String> {
    let state = app.state::<MidiState>();
    let mut conn_guard = state.connection.lock().unwrap_or_else(|e| e.into_inner());

    // Drop any existing connection
    if let Some(old) = conn_guard.take() {
        drop(old);
    }

    let input = MidiInput::new("gathering-midi").map_err(|e| e.to_string())?;
    let ports = input.ports();

    // Find port by name rather than index
    let port = ports
        .iter()
        .find(|p| input.port_name(p).ok().as_deref() == Some(&name))
        .ok_or_else(|| format!("MIDI port '{}' not found", name))?;

    let port_name = name.clone();

    let app_handle = app.clone();
    let connection = input
        .connect(
            port,
            "gathering-midi-in",
            move |_timestamp, message, _| {
                if message.len() >= 3 {
                    let _ = app_handle.emit(
                        "midi-message",
                        MidiEvent {
                            status: message[0],
                            note: message[1],
                            velocity: message[2],
                        },
                    );
                }
            },
            (),
        )
        .map_err(|e| e.to_string())?;

    *conn_guard = Some(connection);
    Ok(port_name)
}

/// Disconnect the current MIDI input.
#[tauri::command]
pub fn midi_disconnect(app: AppHandle) {
    let state = app.state::<MidiState>();
    let mut conn_guard = state.connection.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = conn_guard.take() {
        drop(old);
    }
}
