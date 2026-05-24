use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Emitter, Manager, RunEvent, State, Window,
};

const OPEN_MENU_ID: &str = "file-open";

struct PendingOpenedFile(Mutex<Option<MarkdownFile>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownFile {
    path: String,
    file_name: String,
    base_dir: String,
    contents: String,
    modified: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteMarkdownFileResult {
    saved: Option<MarkdownFile>,
    conflict: Option<MarkdownFile>,
}

fn modified_millis(path: &Path) -> Result<u128, String> {
    let modified = fs::metadata(path)
        .map_err(|error| format!("Could not read file metadata: {error}"))?
        .modified()
        .map_err(|error| format!("Could not read modified time: {error}"))?;

    Ok(modified
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis())
}

fn read_path(path: PathBuf) -> Result<MarkdownFile, String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve file path: {error}"))?;

    if !canonical_path.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    let contents = fs::read_to_string(&canonical_path)
        .map_err(|error| format!("Could not read Markdown file: {error}"))?;

    let base_dir = canonical_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("/"));

    let file_name = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled.md")
        .to_string();

    Ok(MarkdownFile {
        path: canonical_path.to_string_lossy().to_string(),
        file_name,
        base_dir: base_dir.to_string_lossy().to_string(),
        contents,
        modified: modified_millis(&canonical_path)?,
    })
}

fn update_window_title(window: &Window, file_name: &str) {
    let _ = window.set_title(file_name);
}

fn open_path(app: &tauri::AppHandle, path: PathBuf) {
    match read_path(path) {
        Ok(file) => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&file.file_name);
            }

            if let Some(pending) = app.try_state::<PendingOpenedFile>() {
                if let Ok(mut pending_file) = pending.0.lock() {
                    *pending_file = Some(file.clone());
                }
            }

            let _ = app.emit("markdown-file-opened", file);
        }
        Err(error) => {
            let _ = app.emit("markdown-file-open-error", error);
        }
    }
}

fn open_selected_file(app: &tauri::AppHandle) {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
        .pick_file()
    else {
        return;
    };

    open_path(app, path);
}

fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let open = MenuItemBuilder::with_id(OPEN_MENU_ID, "Open...")
        .accelerator("CmdOrCtrl+O")
        .build(handle)?;

    let app_menu = SubmenuBuilder::new(handle, "Markdown Mode")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(&open)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .copy()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(handle, "Window")
        .minimize()
        .fullscreen()
        .build()?;

    let menu = MenuBuilder::new(handle)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;

    app.set_menu(menu)?;

    Ok(())
}

#[tauri::command]
fn open_markdown_dialog(window: Window) -> Result<Option<MarkdownFile>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
        .pick_file()
    else {
        return Ok(None);
    };

    let file = read_path(path)?;
    update_window_title(&window, &file.file_name);

    Ok(Some(file))
}

#[tauri::command]
fn read_markdown_file(window: Window, path: String) -> Result<MarkdownFile, String> {
    let file = read_path(PathBuf::from(path))?;
    update_window_title(&window, &file.file_name);

    Ok(file)
}

#[tauri::command]
fn write_markdown_file(
    window: Window,
    path: String,
    contents: String,
    expected_modified: Option<String>,
) -> Result<WriteMarkdownFileResult, String> {
    let canonical_path = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve file path: {error}"))?;

    if !canonical_path.is_file() {
        return Err("Selected path is not a file.".to_string());
    }

    let current_modified = modified_millis(&canonical_path)?.to_string();
    if expected_modified
        .as_deref()
        .is_some_and(|expected| expected != current_modified)
    {
        return Ok(WriteMarkdownFileResult {
            saved: None,
            conflict: Some(read_path(canonical_path)?),
        });
    }

    fs::write(&canonical_path, contents)
        .map_err(|error| format!("Could not save Markdown file: {error}"))?;

    let file = read_path(canonical_path)?;
    update_window_title(&window, &file.file_name);

    Ok(WriteMarkdownFileResult {
        saved: Some(file),
        conflict: None,
    })
}

#[tauri::command]
fn take_pending_opened_file(state: State<PendingOpenedFile>) -> Option<MarkdownFile> {
    state.0.lock().ok()?.take()
}

#[tauri::command]
fn notify_review_complete() -> bool {
    false
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(PendingOpenedFile(Mutex::new(None)))
        .setup(|app| {
            build_menu(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == OPEN_MENU_ID {
                open_selected_file(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_markdown_dialog,
            read_markdown_file,
            write_markdown_file,
            take_pending_opened_file,
            notify_review_complete
        ])
        .build(tauri::generate_context!())
        .expect("error while building Markdown Mode");

    app.run(|app, event| {
        if let RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    open_path(app, path);
                    break;
                }
            }
        }
    });
}
