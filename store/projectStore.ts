import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Floor, Project, Space } from "@/types/space";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Rooms placed around origin so first room is centered in both 2D and 3D
const CENTERED_POSITIONS: [number, number][] = [
  [0, 0], [240, 0], [-240, 0],
  [0, 200], [240, 200], [-240, 200],
  [0, 400], [240, 400], [-240, 400],
];

const PALETTE = [
  "#EF9A9A", "#F48FB1", "#CE93D8", "#90CAF9",
  "#80DEEA", "#A5D6A7", "#FFE082", "#FFCC80", "#BCAAA4",
];

interface ProjectState {
  project: Project;
  activeFloorId: string | null;
  selectedSpaceId: string | null;

  updateProjectName: (name: string) => void;

  addFloor: () => void;
  removeFloor: (floorId: string) => void;
  setActiveFloor: (floorId: string) => void;

  addSpace: (floorId: string, partial: Partial<Space>) => void;
  updateSpace: (floorId: string, spaceId: string, changes: Partial<Space>) => void;
  removeSpace: (floorId: string, spaceId: string) => void;
  addRoomToActiveFloor: () => void;

  setSelectedSpace: (id: string | null) => void;
}

function makeDefaultFloor(): Floor {
  return { id: generateId(), name: "Floor 1", elevation: 0, spaces: [] };
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => {
      const defaultFloor = makeDefaultFloor();
      return {
        project: { id: generateId(), name: "My Project", floors: [defaultFloor] },
        activeFloorId: defaultFloor.id,
        selectedSpaceId: null,

        updateProjectName: (name) =>
          set((s) => ({ project: { ...s.project, name } })),

        addFloor: () =>
          set((s) => {
            const f: Floor = {
              id: generateId(),
              name: `Floor ${s.project.floors.length + 1}`,
              elevation: s.project.floors.length * 350,
              spaces: [],
            };
            return { project: { ...s.project, floors: [...s.project.floors, f] }, activeFloorId: f.id };
          }),

        removeFloor: (floorId) =>
          set((s) => {
            const floors = s.project.floors.filter((f) => f.id !== floorId);
            return {
              project: { ...s.project, floors },
              activeFloorId: s.activeFloorId === floorId ? (floors[0]?.id ?? null) : s.activeFloorId,
              selectedSpaceId: null,
            };
          }),

        setActiveFloor: (floorId) => set({ activeFloorId: floorId, selectedSpaceId: null }),

        addSpace: (floorId, partial) =>
          set((s) => {
            const space: Space = {
              id: generateId(), name: "Room",
              x: -100, y: -75, width: 200, height: 150, color: "#90CAF9",
              ...partial,
            };
            return {
              project: {
                ...s.project,
                floors: s.project.floors.map((f) =>
                  f.id === floorId ? { ...f, spaces: [...f.spaces, space] } : f
                ),
              },
            };
          }),

        addRoomToActiveFloor: () =>
          set((s) => {
            if (!s.activeFloorId) return s;
            const floor = s.project.floors.find((f) => f.id === s.activeFloorId);
            if (!floor) return s;
            const count = floor.spaces.length;
            const [cx, cy] = CENTERED_POSITIONS[count] ?? [count * 240, 0];
            const space: Space = {
              id: generateId(),
              name: `Room ${count + 1}`,
              x: cx - 100, y: cy - 75,
              width: 200, height: 150,
              color: PALETTE[count % PALETTE.length],
            };
            return {
              project: {
                ...s.project,
                floors: s.project.floors.map((f) =>
                  f.id === s.activeFloorId ? { ...f, spaces: [...f.spaces, space] } : f
                ),
              },
              selectedSpaceId: space.id,
            };
          }),

        updateSpace: (floorId, spaceId, changes) =>
          set((s) => ({
            project: {
              ...s.project,
              floors: s.project.floors.map((f) =>
                f.id === floorId
                  ? { ...f, spaces: f.spaces.map((sp) => (sp.id === spaceId ? { ...sp, ...changes } : sp)) }
                  : f
              ),
            },
          })),

        removeSpace: (floorId, spaceId) =>
          set((s) => ({
            project: {
              ...s.project,
              floors: s.project.floors.map((f) =>
                f.id === floorId ? { ...f, spaces: f.spaces.filter((sp) => sp.id !== spaceId) } : f
              ),
            },
            selectedSpaceId: null,
          })),

        setSelectedSpace: (id) => set({ selectedSpaceId: id }),
      };
    },
    { name: "space-planner-v1" }
  )
);
