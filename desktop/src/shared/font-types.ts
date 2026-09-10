export interface FontFaceInfo {
  weight: number;
  style: 'normal' | 'italic';
  localNames: string[];
  url?: string;
}

export interface FontFamilyInfo {
  family: string;
  faces: FontFaceInfo[];
}
