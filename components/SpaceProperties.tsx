'use client';

import { useProjectStore } from '@/store/projectStore';
import { Space } from '@/types/space';

interface Props {
  floorId: string;
  spaceId: string;
}

export default function SpaceProperties({ floorId, spaceId }: Props) {
  const { project, updateSpace } = useProjectStore();
  const floor = project.floors.find((f) => f.id === floorId);
  const space = floor?.spaces.find((s) => s.id === spaceId);

  if (!space) return null;

  const update = (changes: Partial<Space>) =>
    updateSpace(floorId, spaceId, changes);

  return (
    <div className="p-4 border-l border-gray-200 w-64 bg-white flex flex-col gap-4 shrink-0">
      <h3 className="font-semibold text-xs text-gray-500 uppercase tracking-widest">
        Properties
      </h3>

      <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
        Name
        <input
          className="border border-gray-300 rounded px-2 py-1 font-normal text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400"
          value={space.name}
          onChange={(e) => update({ name: e.target.value })}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
        Width (px)
        <input
          type="number"
          min={10}
          className="border border-gray-300 rounded px-2 py-1 font-normal text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400"
          value={space.width}
          onChange={(e) => update({ width: Math.max(10, Number(e.target.value)) })}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
        Height (px)
        <input
          type="number"
          min={10}
          className="border border-gray-300 rounded px-2 py-1 font-normal text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400"
          value={space.height}
          onChange={(e) => update({ height: Math.max(10, Number(e.target.value)) })}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-gray-700">
        Color
        <input
          type="color"
          className="border border-gray-300 rounded h-9 w-full cursor-pointer"
          value={space.color}
          onChange={(e) => update({ color: e.target.value })}
        />
      </label>
    </div>
  );
}
