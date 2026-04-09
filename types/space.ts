export interface Space {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface Floor {
  id: string;
  name: string;
  elevation: number;
  spaces: Space[];
}

export interface Project {
  id: string;
  name: string;
  floors: Floor[];
}
