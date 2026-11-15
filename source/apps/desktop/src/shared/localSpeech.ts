export type SpeechModelRole="asr"|"aligner";
export interface InstalledSpeechModel {id:string;role:SpeechModelRole;label:string;directory:string;fingerprint:string}
export interface SpeechModelDownload {id:string;role:SpeechModelRole;label:string;source:string;revision:string;bytes:number;directory:string}
export interface LocalSpeechStatus {
  supported:boolean;ready:boolean;runtimeReady:boolean;
  asrModel:string;alignerModel:string;message:string;
  modelDirectory:string;installed:InstalledSpeechModel[];catalog:SpeechModelDownload[];
  selected:{asr:string;aligner:string};issues:string[];
}
export interface LocalSpeechUpdate {message:string;sourcePath?:string;done?:number;total?:number}
