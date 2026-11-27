/*
 * wumpy-pointer: mouse buttons and the wheel, on Hyprland (or any compositor
 * with wlr-virtual-pointer), without root.
 *
 * Windows has SendInput; Wayland gives an ordinary program no way to click
 * anywhere but its own windows. The one way in that needs no root and no
 * /dev/uinput is the compositor's virtual pointer, which is what wlrctl and
 * wtype's pointer cousins use. This is the smallest program that speaks it.
 *
 * It does not move the pointer. Where the pointer is goes through
 * `hyprctl dispatch movecursor`, which takes the same layout coordinates
 * Electron's screen module reports, so there is one coordinate system and no
 * guessing at how an absolute virtual-pointer extent maps onto several
 * monitors. This presses at wherever the pointer now is.
 *
 *   wumpy-pointer click left|right|middle <times>
 *   wumpy-pointer scroll <notches>        positive is down
 *   wumpy-pointer key <mods|-> <keysym> <times>   mods: ctrl,shift,alt,logo
 *
 * The keys are here, not in wtype, because of input methods. With fcitx5
 * running, Hyprland hands every keyboard's keys to it, and it forwards the
 * ones it does not eat (BackSpace, Delete, ctrl+a ...) through its own virtual
 * keyboard, using the keymap of the keyboard they came from. wtype's keymap is
 * a scrap made up on the spot, fcitx5 cannot use it, and those keys vanish -
 * while letters, which fcitx5 commits as text, still arrive, so typing looks
 * fine and every correction silently fails. This keyboard uploads a whole
 * standard keymap (the user's layout, from the usual XKB_DEFAULT_* names) and
 * presses real evdev keycodes, the same as the laptop's own keyboard.
 *
 * Prints one line, "ok ..." or "FAILED <why>", and exits 0 or 1.
 * Built by scripts/build-linux-helper.mjs; driven by resources/linux/desktop.py.
 */
#define _GNU_SOURCE
#include <linux/input-event-codes.h>
#include <sys/mman.h>
#include <xkbcommon/xkbcommon.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

static struct wl_seat *seat;
static struct zwlr_virtual_pointer_manager_v1 *manager;
static struct zwp_virtual_keyboard_manager_v1 *keyboards;

static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  (void)data;
  if (strcmp(interface, wl_seat_interface.name) == 0 && !seat) {
    seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  } else if (strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name) == 0) {
    manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, version < 2 ? version : 2);
  } else if (strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name) == 0) {
    keyboards = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
  }
}

static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}

static const struct wl_registry_listener listener = {global, global_remove};

static uint32_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint32_t)(t.tv_sec * 1000 + t.tv_nsec / 1000000);
}

static void pause_ms(int ms) {
  struct timespec t = {ms / 1000, (long)(ms % 1000) * 1000000L};
  nanosleep(&t, NULL);
}

static struct xkb_keymap *keymap;
static struct xkb_state *kstate;
static struct zwp_virtual_keyboard_v1 *keyboard;

/* The keycode that gives this keysym, and whether it takes shift to. */
static xkb_keycode_t find_key(xkb_keysym_t want, int *shift) {
  for (xkb_keycode_t kc = xkb_keymap_min_keycode(keymap); kc <= xkb_keymap_max_keycode(keymap); kc++) {
    for (xkb_level_index_t level = 0; level < 2; level++) {
      const xkb_keysym_t *syms;
      int n = xkb_keymap_key_get_syms_by_level(keymap, kc, 0, level, &syms);
      for (int i = 0; i < n; i++) {
        if (syms[i] == want) {
          *shift = (int)level;
          return kc;
        }
      }
    }
  }
  return XKB_KEYCODE_INVALID;
}

static void send_key(struct wl_display *display, xkb_keycode_t kc, int down) {
  xkb_state_update_key(kstate, kc, down ? XKB_KEY_DOWN : XKB_KEY_UP);
  zwp_virtual_keyboard_v1_key(keyboard, now_ms(), kc - 8, down ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
  zwp_virtual_keyboard_v1_modifiers(keyboard, xkb_state_serialize_mods(kstate, XKB_STATE_MODS_DEPRESSED),
                                    xkb_state_serialize_mods(kstate, XKB_STATE_MODS_LATCHED),
                                    xkb_state_serialize_mods(kstate, XKB_STATE_MODS_LOCKED),
                                    xkb_state_serialize_layout(kstate, XKB_STATE_LAYOUT_EFFECTIVE));
  wl_display_flush(display);
  pause_ms(8);
}

static int keys(struct wl_display *display, const char *mods, const char *name, int times) {
  struct xkb_context *ctx = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
  struct xkb_rule_names names = {0}; /* NULLs: the XKB_DEFAULT_* environment, else "us" */
  keymap = ctx ? xkb_keymap_new_from_names(ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS) : NULL;
  if (!keymap) {
    puts("FAILED no-keymap");
    return 1;
  }
  xkb_keysym_t sym = xkb_keysym_from_name(name, XKB_KEYSYM_NO_FLAGS);
  if (sym == XKB_KEY_NoSymbol) sym = xkb_keysym_from_name(name, XKB_KEYSYM_CASE_INSENSITIVE);
  int shift = 0;
  xkb_keycode_t kc = sym == XKB_KEY_NoSymbol ? XKB_KEYCODE_INVALID : find_key(sym, &shift);
  if (kc == XKB_KEYCODE_INVALID) {
    printf("FAILED unknown-key %s\n", name);
    return 1;
  }
  static const struct { const char *name; xkb_keysym_t sym; } MOD[] = {
    {"ctrl", XKB_KEY_Control_L}, {"shift", XKB_KEY_Shift_L}, {"alt", XKB_KEY_Alt_L}, {"logo", XKB_KEY_Super_L}};
  xkb_keycode_t held[5];
  int nheld = 0, wantshift = shift;
  for (size_t m = 0; m < sizeof MOD / sizeof *MOD; m++) {
    if (strcmp(mods, "-") == 0) break;
    char list[64];
    snprintf(list, sizeof list, ",%s,", mods);
    char needle[16];
    snprintf(needle, sizeof needle, ",%s,", MOD[m].name);
    if (!strstr(list, needle)) continue;
    if (MOD[m].sym == XKB_KEY_Shift_L) wantshift = 1;
    else {
      int ignored;
      xkb_keycode_t mk = find_key(MOD[m].sym, &ignored);
      if (mk == XKB_KEYCODE_INVALID) {
        printf("FAILED no-modifier-key %s\n", MOD[m].name);
        return 1;
      }
      held[nheld++] = mk;
    }
  }
  if (wantshift) {
    int ignored;
    xkb_keycode_t sk = find_key(XKB_KEY_Shift_L, &ignored);
    if (sk != XKB_KEYCODE_INVALID) held[nheld++] = sk;
  }

  char *text = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
  size_t size = strlen(text) + 1;
  int fd = memfd_create("wumpy-keymap", MFD_CLOEXEC);
  if (fd < 0 || write(fd, text, size) != (ssize_t)size) {
    puts("FAILED keymap-fd");
    return 1;
  }
  free(text);
  keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(keyboards, seat);
  zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, size);
  kstate = xkb_state_new(keymap);
  /* A new device again: let it be added, keymap and all, before its first key. */
  wl_display_roundtrip(display);
  pause_ms(20);

  for (int i = 0; i < nheld; i++) send_key(display, held[i], 1);
  for (int i = 0; i < times; i++) {
    send_key(display, kc, 1);
    send_key(display, kc, 0);
  }
  for (int i = nheld - 1; i >= 0; i--) send_key(display, held[i], 0);
  wl_display_roundtrip(display);
  zwp_virtual_keyboard_v1_destroy(keyboard);
  close(fd);
  printf("ok key=%s times=%d\n", name, times);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    puts("FAILED usage: click left|right|middle <times> | scroll <notches>");
    return 1;
  }
  struct wl_display *display = wl_display_connect(NULL);
  if (!display) {
    puts("FAILED no-wayland-display");
    return 1;
  }
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &listener, NULL);
  wl_display_roundtrip(display);
  if (strcmp(argv[1], "key") == 0) {
    if (argc < 5) {
      puts("FAILED usage: key <mods|-> <keysym> <times>");
      return 1;
    }
    if (!keyboards || !seat) {
      puts("FAILED compositor-has-no-virtual-keyboard");
      wl_display_disconnect(display);
      return 1;
    }
    int times = atoi(argv[4]);
    if (times < 1 || times > 400) {
      printf("FAILED repeat-out-of-range=%d\n", times);
      return 1;
    }
    int code = keys(display, argv[2], argv[3], times);
    wl_display_disconnect(display);
    return code;
  }
  if (!manager) {
    puts("FAILED compositor-has-no-virtual-pointer");
    wl_display_disconnect(display);
    return 1;
  }
  struct zwlr_virtual_pointer_v1 *pointer = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(manager, seat);
  /* A brand-new input device: let the compositor finish adding it before
     the first event, or the first press can be dropped. */
  wl_display_roundtrip(display);

  int code = 0;
  if (strcmp(argv[1], "click") == 0) {
    uint32_t button = BTN_LEFT;
    if (strcmp(argv[2], "right") == 0) button = BTN_RIGHT;
    else if (strcmp(argv[2], "middle") == 0) button = BTN_MIDDLE;
    int times = argc > 3 ? atoi(argv[3]) : 1;
    if (times < 1) times = 1;
    if (times > 3) times = 3;
    for (int i = 0; i < times; i++) {
      zwlr_virtual_pointer_v1_button(pointer, now_ms(), button, WL_POINTER_BUTTON_STATE_PRESSED);
      zwlr_virtual_pointer_v1_frame(pointer);
      wl_display_flush(display);
      pause_ms(12);
      zwlr_virtual_pointer_v1_button(pointer, now_ms(), button, WL_POINTER_BUTTON_STATE_RELEASED);
      zwlr_virtual_pointer_v1_frame(pointer);
      wl_display_flush(display);
      /* Inside every toolkit's double-click time, outside its debounce. */
      if (i + 1 < times) pause_ms(60);
    }
    printf("ok button=%s times=%d\n", argv[2], times);
  } else if (strcmp(argv[1], "scroll") == 0) {
    int notches = atoi(argv[2]);
    if (notches > 30) notches = 30;
    if (notches < -30) notches = -30;
    int step = notches > 0 ? 1 : -1;
    for (int i = 0; i != notches; i += step) {
      uint32_t t = now_ms();
      zwlr_virtual_pointer_v1_axis_source(pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
      /* 15 is one wheel click in libinput's units, the same as a real mouse. */
      zwlr_virtual_pointer_v1_axis_discrete(pointer, t, WL_POINTER_AXIS_VERTICAL_SCROLL, wl_fixed_from_int(15 * step), step);
      zwlr_virtual_pointer_v1_frame(pointer);
      wl_display_flush(display);
      pause_ms(16);
    }
    printf("ok notches=%d\n", notches);
  } else {
    printf("FAILED unknown-verb %s\n", argv[1]);
    code = 1;
  }

  wl_display_roundtrip(display);
  zwlr_virtual_pointer_v1_destroy(pointer);
  zwlr_virtual_pointer_manager_v1_destroy(manager);
  wl_display_roundtrip(display);
  wl_display_disconnect(display);
  return code;
}
