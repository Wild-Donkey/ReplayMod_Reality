import { mkdirSync } from "node:fs";
import { storagePaths } from "./paths";
import { LocalCache } from "./snapshots";
import { SettingsStore } from "./settings";
import { upgradeStorage } from "./upgrade";

// One owner for every application storage path. No build mode, URL or cwd input.
export class AppStorage {
  readonly paths;
  readonly settings: SettingsStore;
  readonly state: LocalCache;
  readonly snapshots: LocalCache;
  readonly maps: LocalCache;

  constructor(platform: NodeJS.Platform, home: string, appData: string, env: NodeJS.ProcessEnv) {
    this.paths = storagePaths(platform, home, appData, env);
    mkdirSync(this.paths.data, { recursive: true, mode: 0o700 });
    mkdirSync(this.paths.session, { recursive: true, mode: 0o700 });
    this.settings = new SettingsStore(this.paths.config);
    this.state = new LocalCache(this.paths.state);
    this.snapshots = new LocalCache(this.paths.snapshots);
    this.maps = new LocalCache(this.paths.maps);
    upgradeStorage(this.paths.data, this.paths.config, this.state, this.settings);
  }
}
