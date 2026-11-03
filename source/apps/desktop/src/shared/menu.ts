export const MENU_ACTION_CHANNEL = "menu:action";
export const MENU_STATE_CHANNEL = "menu:state";

export type MenuAction = "open-location" | "open-media" | "open-subtitles" | "set-in" | "set-out";
export interface MenuState {
  openLocation: boolean;
  openMedia: boolean;
  subtitles: boolean;
  range: boolean;
}
