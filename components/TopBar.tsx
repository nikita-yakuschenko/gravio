'use client';

import { Button } from '@/components/ui/button';
import { useProjectStore } from '@/store/projectStore';
import { exportToGltf } from '@/lib/exportGltf';
import { exportToJson } from '@/lib/exportJson';

interface Props {
  show2D: boolean;
  onToggle2D: () => void;
}

export default function TopBar({ show2D, onToggle2D }: Props) {
  const { project, activeFloorId, addRoomToActiveFloor } = useProjectStore();

  return (
    <header className="flex items-center justify-between px-4 h-12 border-b border-gray-200 bg-white shrink-0">
      <span className="text-sm font-semibold text-gray-700 tracking-wide select-none">
        Space Planner
      </span>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!activeFloorId}
          onClick={addRoomToActiveFloor}
        >
          + Add Room
        </Button>

        <div className="w-px h-5 bg-gray-200 mx-1" />

        <Button
          size="sm"
          variant={show2D ? 'default' : 'outline'}
          onClick={onToggle2D}
        >
          2D Plan
        </Button>

        <div className="w-px h-5 bg-gray-200 mx-1" />

        <Button
          size="sm"
          variant="outline"
          onClick={() => exportToJson(project)}
        >
          Export JSON
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => exportToGltf(project)}
        >
          Export glTF
        </Button>
      </div>
    </header>
  );
}
