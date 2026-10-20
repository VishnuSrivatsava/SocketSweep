//! Discovery is read-only. Only an explicitly selected, currently ready serial
//! may be handed to a session; discovery order never grants selection authority.
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, serde::Serialize)]
pub(super) struct Device {
    serial: String,
    state: String,
    model: Option<String>,
}

pub(super) fn list(adb: &Path) -> Result<Vec<Device>, String> {
    parse(&crate::adb(adb, &["devices", "-l"])?)
}

pub(super) fn require_selected(adb: &Path, serial: &str) -> Result<(), String> {
    if serial.is_empty() || serial.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Choose a device before connecting.".into());
    }
    let devices = list(adb)?;
    let device = devices
        .iter()
        .find(|device| device.serial == serial)
        .ok_or("Selected device is disconnected. Refresh the list and choose a device.")?;
    match device.state.as_str() {
        "device" => Ok(()),
        "unauthorized" => Err("Selected device is unauthorized. Unlock it and approve USB debugging, then refresh.".into()),
        "offline" => Err("Selected device is offline. Reconnect it and refresh.".into()),
        "no permissions" => Err("No USB permission for the selected device. Check your host's USB/udev permissions and refresh.".into()),
        _ => Err("Selected device is not ready for scanning. Reconnect it and refresh.".into()),
    }
}

fn parse(output: &str) -> Result<Vec<Device>, String> {
    let mut lines = output.lines().filter(|line| !line.trim().is_empty());
    if lines.next().map(str::trim) != Some("List of devices attached") {
        return Err("ADB returned an invalid device list.".into());
    }
    let mut serials = HashSet::new();
    let mut devices = Vec::new();
    for line in lines {
        let mut fields = line.split_whitespace();
        let serial = fields.next().ok_or("Missing ADB device serial")?;
        let state = fields.next().ok_or("Missing ADB device state")?;
        if serial.chars().any(char::is_control) || !serials.insert(serial.to_string()) {
            return Err("ADB reported invalid or duplicate device serials. Reconnect duplicate transports before scanning.".into());
        }
        let state = if state == "no" && fields.next() == Some("permissions") {
            "no permissions"
        } else {
            state
        };
        let model = fields
            .find_map(|field| field.strip_prefix("model:"))
            .filter(|value| !value.is_empty())
            .map(|value| value.replace('_', " "));
        devices.push(Device {
            serial: serial.into(),
            state: state.into(),
            model,
        });
    }
    Ok(devices)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_usb_wireless_emulator_and_unavailable_devices() {
        let output = "List of devices attached\r\nusb-one\tdevice usb:1 product:foo model:Pixel_9_Pro device:foo transport_id:1\r\n192.0.2.1:5555 device model:Tablet transport_id:2\r\nemulator-5554 offline transport_id:3\r\nphone-two unauthorized usb:2 transport_id:4\r\n???????????? no permissions (check udev rules); transport_id:5\r\nrecovery-phone recovery\r\n";
        let devices = parse(output).unwrap();
        assert_eq!(devices.len(), 6);
        assert_eq!(devices[0].serial, "usb-one");
        assert_eq!(devices[0].model.as_deref(), Some("Pixel 9 Pro"));
        assert_eq!(devices[1].serial, "192.0.2.1:5555");
        assert_eq!(devices[2].state, "offline");
        assert_eq!(devices[3].state, "unauthorized");
        assert_eq!(devices[4].state, "no permissions");
        assert_eq!(devices[5].state, "recovery");
        assert!(devices[5].model.is_none());
    }

    #[test]
    fn empty_valid_lists_are_distinct_from_bad_or_ambiguous_output() {
        assert!(parse("List of devices attached\n\n").unwrap().is_empty());
        for output in [
            "",
            "error: no devices",
            "one device",
            "List of devices attached\none",
            "List of devices attached\none device\none offline\n",
        ] {
            assert!(parse(output).is_err(), "accepted {output:?}");
        }
    }
}
