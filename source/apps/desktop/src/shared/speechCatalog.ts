import catalog from "../../../../resources/speech/models.json";
import type {SpeechModelDownload,SpeechModelRole} from "./localSpeech";

/** Public download metadata is available even before the Electron bridge is ready. */
export function speechDownloadCatalog(root=""):SpeechModelDownload[]{
  return catalog.map(model=>({id:model.id,role:model.role as SpeechModelRole,label:model.label,source:model.source,revision:model.revision,bytes:model.files.reduce((sum,file)=>sum+file.size,0),directory:root?`${root.replace(/[\\/]$/,"")}/${model.id}`:`./${model.id}`}));
}
