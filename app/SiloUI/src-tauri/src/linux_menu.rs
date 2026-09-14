//! GTK owns menu navigation; only the reveal/dismiss gesture is application policy.
use super::{MenuKey, MenuKeys};
use gtk::{gdk, glib, prelude::*};
use std::{cell::RefCell, rc::Rc};
use tauri::WebviewWindow;

struct MenuFocus {
    bar: gtk::MenuBar,
    window: gtk::ApplicationWindow,
    previous: RefCell<Option<gtk::Widget>>,
}
impl MenuFocus {
    fn show(&self) {
        if !self.bar.is_visible() {
            *self.previous.borrow_mut() = self.window.focused_widget();
            self.bar.show();
        }
        self.bar.grab_focus();
        // GTK's keyboard menu entry point activates the first top-level item.
        // This also selects the first available action for keyboard navigation.
        if let Some(first) = self.bar.children().first() {
            first.emit_by_name::<()>("activate-item", &[]);
        }
    }
    fn hide(&self) {
        self.bar.hide();
        let previous = self.previous.borrow_mut().take();
        if let Some(previous) = previous {
            previous.grab_focus();
        }
    }
}
thread_local! {
    static MENU: RefCell<Option<Rc<MenuFocus>>> = const { RefCell::new(None) };
}
pub(super) fn show(_: &WebviewWindow) {
    MENU.with(|menu| {
        if let Some(menu) = menu.borrow().as_ref() {
            menu.show();
        }
    });
}
pub(super) fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let gtk_window = window.gtk_window()?;
    let bar = window
        .default_vbox()?
        .children()
        .into_iter()
        .find_map(|child| child.downcast::<gtk::MenuBar>().ok())
        .ok_or_else(|| {
            tauri::Error::Io(std::io::Error::other("Native menu bar was not installed"))
        })?;
    allow_hidden_accelerators(&bar.clone().upcast());
    bar.set_can_focus(true);
    bar.set_no_show_all(true);
    bar.hide();
    let menu = Rc::new(MenuFocus {
        bar: bar.clone(),
        window: gtk_window.clone(),
        previous: RefCell::new(None),
    });
    MENU.with(|slot| *slot.borrow_mut() = Some(menu.clone()));
    let alt_pending = Rc::new(RefCell::new(MenuKeys::default()));
    let pending = alt_pending.clone();
    let focus = menu.clone();
    gtk_window.connect_key_press_event(move |_, event| {
        let key = event.keyval();
        let modifiers = event.state()
            & (gdk::ModifierType::SHIFT_MASK
                | gdk::ModifierType::CONTROL_MASK
                | gdk::ModifierType::MOD1_MASK
                | gdk::ModifierType::SUPER_MASK
                | gdk::ModifierType::MOD5_MASK);
        let action = pending.borrow_mut().press(
            menu_key(key),
            !modifiers.is_empty(),
            focus.bar.is_visible(),
        );
        if let Some(show) = action {
            if show {
                focus.show();
            } else {
                focus.bar.cancel();
                focus.hide();
            }
            return glib::Propagation::Stop;
        }
        glib::Propagation::Proceed
    });
    let focus = menu.clone();
    let keys_on_blur = alt_pending.clone();
    let keys_on_pointer = alt_pending.clone();
    gtk_window.connect_button_press_event(move |_, _| {
        keys_on_pointer.borrow_mut().cancel();
        glib::Propagation::Proceed
    });
    gtk_window.connect_key_release_event(move |_, event| {
        let action = alt_pending
            .borrow_mut()
            .release(menu_key(event.keyval()), focus.bar.is_visible());
        if let Some(show) = action {
            if show {
                focus.show();
            } else {
                focus.bar.cancel();
                focus.hide();
            }
            return glib::Propagation::Stop;
        }
        glib::Propagation::Proceed
    });
    let focus = menu.clone();
    bar.connect_selection_done(move |_| focus.hide());
    let focus = menu.clone();
    bar.connect_deactivate(move |_| focus.hide());
    gtk_window.connect_focus_out_event(move |_, _| {
        keys_on_blur.borrow_mut().cancel();
        menu.hide();
        glib::Propagation::Proceed
    });
    Ok(())
}

fn menu_key(key: gdk::keys::Key) -> MenuKey {
    match key {
        gdk::keys::constants::Alt_L => MenuKey::LeftAlt,
        gdk::keys::constants::F10 => MenuKey::F10,
        gdk::keys::constants::Escape => MenuKey::Escape,
        _ => MenuKey::Other,
    }
}

// GTK normally rejects accelerators when any ancestor is hidden. The menu is
// deliberately temporary, so availability follows sensitivity, not visibility.
fn allow_hidden_accelerators(shell: &gtk::MenuShell) {
    for child in shell.children() {
        if let Ok(item) = child.downcast::<gtk::MenuItem>() {
            if let Some(submenu) = item
                .submenu()
                .and_then(|menu| menu.downcast::<gtk::MenuShell>().ok())
            {
                allow_hidden_accelerators(&submenu);
            } else {
                item.connect_can_activate_accel(|item, _| item.is_sensitive());
            }
        }
    }
}
