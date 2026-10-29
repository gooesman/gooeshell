export interface UpdateAsset { name:string; url:string; size:number; sha256:string }
export interface UpdateRelease { version:string; page:string; notes:string; assets:UpdateAsset[]; newer:boolean }
