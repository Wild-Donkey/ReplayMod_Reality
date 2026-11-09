import type { AppSettings } from "./settings";
import type { ConfirmedFlightsFile } from "./confirmedFlight";

export interface UserArchive {
  readonly format: "replaymod.user-archive";
  readonly version: 1;
  readonly updatedAt: string;
  readonly settings: AppSettings;
  readonly workspace: Record<string, unknown>;
  readonly lastDatasetSource?: { readonly mainFilePath: string; readonly photoFilePath: string | null };
  readonly lastMedia?: unknown;
  readonly flights?: ConfirmedFlightsFile;
  readonly services: {
    readonly airportsUpdatedAt?: string;
  };
  readonly migrations?: {
    readonly legacyImportedAt?: string;
    readonly annotationsSourceSignature?: string;
  };
}

export const defaultUserArchive = (settings: AppSettings): UserArchive => ({
  format: "replaymod.user-archive",
  version: 1,
  updatedAt: new Date(0).toISOString(),
  settings,
  workspace: {},
  services: {},
});
