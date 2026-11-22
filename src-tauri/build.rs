fn main() {
    // Opt-in, because always running elevated breaks Explorer drag-and-drop,
    // "open folder with Oriel" and autostart. `npm run build:desktop:admin`
    // sets this and embeds a requireAdministrator manifest instead.
    println!("cargo:rerun-if-env-changed=ORIEL_REQUIRE_ADMIN");
    println!("cargo:rerun-if-changed=oriel-admin.manifest");

    if std::env::var("ORIEL_REQUIRE_ADMIN").as_deref() == Ok("1") {
        let windows =
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("oriel-admin.manifest"));
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
            .expect("failed to run tauri-build");
    } else {
        tauri_build::build();
    }
}
