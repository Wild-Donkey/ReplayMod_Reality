export interface DatasetSource {readonly mainFilePath:string; readonly photoFilePath:string|null}
export interface DatasetLookup {
  exists:(file:string)=>Promise<boolean>;
  latest:(previous:DatasetSource|undefined)=>Promise<DatasetSource|null>;
}

export async function resolveDatasetSource(source:DatasetSource|undefined,io:DatasetLookup):Promise<DatasetSource|null> {
  if(source && await io.exists(source.mainFilePath)) {
    // Losing an optional photo file must not switch the primary trajectory.
    return {...source,photoFilePath:source.photoFilePath && await io.exists(source.photoFilePath)?source.photoFilePath:null};
  }
  return io.latest(source);
}

export async function restoreDataset<T>(
  source:DatasetSource|undefined,key:string|undefined,
  io:DatasetLookup&{cached:(key:string)=>Promise<T|null>;read:(main:string,photo:string|null)=>Promise<T>},
):Promise<T|null> {
  const selected=await resolveDatasetSource(source,io);
  if(selected)return io.read(selected.mainFilePath,selected.photoFilePath);
  if(key){const saved=await io.cached(key);if(saved)return saved;}
  if(source)throw new Error("上次打开的 CSV 已不存在，数据目录中也未找到可用 CSV，请重新选择。");
  return null;
}
