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
 *
 * Prints one line, "ok ..." or "FAILED <why>", and exits 0 or 1.
 * Built by scripts/build-linux-helper.mjs; driven by resources/linux/desktop.py.
 */
#include <linux/input-event-codes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

static struct wl_seat *seat;
static struct zwlr_virtual_pointer_manager_v1 *manager;

static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  (void)data;
  if (strcmp(interface, wl_seat_interface.name) == 0 && !seat) {
    seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  } else if (strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name) == 0) {
    manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, version < 2 ? version : 2);
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
