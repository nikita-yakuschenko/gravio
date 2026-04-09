import { create } from "zustand";
import { Floor, Project, Space } from "@/types/space";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const PALETTE = [
  "#EF9A9A", "#F48FB1", "#CE93D8", "#90CAF9",
  "#80DEEA", "#A5D6A7", "#FFE082", "#FFCC80", "#BCAAA4",
];

interface ProjectState {
  project: Project;
  activeFloorId: string | null;
  selectedSpaceId: string | null;

  // Project actions
  updateProjectName: (name: string) => void;

  // Floor actions
  addFloor: () => void;
  removeFloor: (floorId: string) => void;
  setActiveFloor: (floorId: string) => void;

  // Space actions
  addSpace: (floorId: string, partial: Partial<Space>) => void;
  updateSpace: (floorId: string, spaceId: string, changes: Partial<Space>) => void;
  removeSpace: (floorId: string, spaceId: string) => void;
  addRoomToActiveFloor: () => void;

  // Selection
  setSelectedSpace: (id: string | null) => void;
}

const defaultFloor: Floor = {
  id: generateId(),
  name: "Floor 1",
  elevation: 0,
  spaces: [],
};

export const useProjectStore = create<ProjectState>((set) => ({
  project: {
    id: generateId(),
    name: "My Project",
    floors: [defaultFloor],
  },
  activeFloorId: defaultFloor.id,
  selectedSpaceId: null,

  updateProjectName: (name) =>
    set((state) => ({ project: { ...state.project, name } })),

  addFloor: () =>
    set((state) => {
      const newFloor: Floor = {
        id: generateId(),
        name: `Floor ${state.project.floors.length + 1}`,
        elevation: state.project.floors.length * 350,
        spaces: [],
      };
      return {
        project: { ...state.project, floors: [...state.project.floors, newFloor] },
        activeFloorId: newFloor.id,
      };
    }),

  removeFloor: (floorId) =>
    set((state) => {
      const floors = state.project.floors.filter((f) => f.id !== floorId);
      return {
        project: { ...state.project, floors },
        activeFloorId:
          state.activeFloorId === floorId ? (floors[0]?.id ?? null) : state.activeFloorId,
        selectedSpaceId: null,
      };
    }),

  setActiveFloor: (floorId) => set({ activeFloorId: floorId, selectedSpaceId: null }),

  addSpace: (floorId, partial) =>
    set((state) => {
      const newSpace: Space = {
        id: generateId(),
        name: "Room",
        x: 100, y: 100, width: 200, height: 150,
        color: "#90CAF9",
        ...partial,
      };
      return {
        project: {
          ...state.project,
          floors: state.project.floors.map((f) =>
            f.id === floorId ? { ...f, spaces: [...f.spaces, newSpace] } : f
          ),
        },
      };
    }),

  addRoomToActiveFloor: () =>
    set((state) => {
      if (!state.activeFloorId) return state;
      const floor = state.project.floors.find((f) => f.id === state.activeFloorId);
      if (!floor) return state;
      const count = floor.spaces.length;
      const newSpace: Space = {
        id: generateId(),
        name: `Room ${count + 1}`,
        x: 60 + (count % 5) * 220,
        y: 60 + Math.floor(count / 5) * 180,
        width: 200,
        height: 150,
        color: PALETTE[count % PALETTE.length],
      };
      return {
        project: {
          ...state.project,
          floors: state.project.floors.map((f) =>
            f.id === state.activeFloorId ? { ...f, spaces: [...f.spaces, newSpace] } : f
          ),
        },
        selectedSpaceId: newSpace.id,
      };
    }),

  updateSpace: (floorId, spaceId, changes) =>
    set((state) => ({
      project: {
        ...state.project,
        floors: state.project.floors.map((f) =>
          f.id === floorId
            ? { ...f, spaces: f.spaces.map((s) => (s.id === spaceId ? { ...s, ...changes } : s)) }
            : f
        ),
      },
    })),

  removeSpace: (floorId, spaceId) =>
    set((state) => ({
      project: {
        ...state.project,
        floors: state.project.floors.map((f) =>
          f.id === floorId ? { ...f, spaces: f.spaces.filter((s) => s.id !== spaceId) } : f
        ),
      },
      selectedSpaceId: null,
    })),

  setSelectedSpace: (id) => set({ selectedSpaceId: id }),
}));
