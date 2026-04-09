'use client';

import { useProjectStore } from '@/store/projectStore';

export default function Sidebar() {
  const {
    project,
    activeFloorId,
    updateProjectName,
    addFloor,
    removeFloor,
    setActiveFloor,
  } = useProjectStore();

  return (
    <aside className="w-60 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col overflow-hidden">
      {/* Project name */}
      <div className="px-3 pt-4 pb-3 border-b border-gray-200">
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-widest mb-1">
          Project
        </label>
        <input
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
          value={project.name}
          onChange={(e) => updateProjectName(e.target.value)}
        />
      </div>

      {/* Floor list */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 pt-3 pb-1 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-widest">
            Floors
          </span>
          <button
            onClick={addFloor}
            className="text-xs bg-blue-600 text-white rounded px-2 py-0.5 hover:bg-blue-700 transition-colors"
          >
            + Add
          </button>
        </div>

        <ul className="px-2 pb-2 flex flex-col gap-1">
          {project.floors.map((floor) => {
            const isActive = floor.id === activeFloorId;
            return (
              <li
                key={floor.id}
                className={`flex items-center justify-between rounded px-2 py-1.5 cursor-pointer select-none text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'hover:bg-gray-200 text-gray-700'
                }`}
                onClick={() => setActiveFloor(floor.id)}
              >
                <span className="truncate flex-1">{floor.name}</span>
                <span
                  className={`text-xs ml-1 opacity-60 ${isActive ? 'text-blue-100' : 'text-gray-400'}`}
                >
                  {floor.elevation}cm
                </span>
                {project.floors.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFloor(floor.id);
                    }}
                    className={`ml-2 rounded hover:opacity-100 opacity-60 font-bold leading-none ${
                      isActive ? 'text-blue-100 hover:text-white' : 'text-gray-400 hover:text-red-500'
                    }`}
                    title="Remove floor"
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Stats */}
      <div className="px-3 py-2 border-t border-gray-200 text-xs text-gray-400">
        {project.floors.reduce((acc, f) => acc + f.spaces.length, 0)} room
        {project.floors.reduce((acc, f) => acc + f.spaces.length, 0) !== 1 ? 's' : ''} total
      </div>
    </aside>
  );
}
