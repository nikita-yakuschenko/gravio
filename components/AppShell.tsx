'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import TopBar from './TopBar';
import Sidebar from './Sidebar';
import FloorPlanEditor from './FloorPlanEditor';
import SpaceInspector from './SpaceInspector';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const ThreeDViewer = dynamic(() => import('./ThreeDViewer'), {
  ssr: false,
  loading: () => (
    <div style={{ width: '100%', height: '100%', background: '#111827', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B7280', fontSize: 14 }}>
      Loading 3D…
    </div>
  ),
});

const TOPBAR_H = 48;

export default function AppShell() {
  const [show2D, setShow2D] = useState(false);
  const contentHeight = `calc(100vh - ${TOPBAR_H}px)`;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar show2D={show2D} onToggle2D={() => setShow2D((v) => !v)} />

      {/* ── Desktop (md+) ── */}
      <div className="hidden md:flex" style={{ height: contentHeight }}>
        <Sidebar />

        {/* 2D panel — auxiliary, toggled */}
        {show2D && (
          <div style={{
            width: 380, flexShrink: 0,
            borderRight: '1px solid #E5E7EB',
            position: 'relative', overflow: 'hidden',
          }}>
            <FloorPlanEditor />
          </div>
        )}

        {/* 3D viewer — primary, always visible */}
        <div style={{ flex: 1 }}>
          <ThreeDViewer />
        </div>

        {/* Inspector — appears when a space is selected */}
        <SpaceInspector />
      </div>

      {/* ── Mobile (< md) ── */}
      <div className="flex flex-col md:hidden" style={{ height: contentHeight }}>
        <Tabs defaultValue="3d" className="flex flex-col h-full">
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 12px', borderBottom: '1px solid #E5E7EB', background: '#fff', flexShrink: 0,
          }}>
            <TabsList>
              <TabsTrigger value="3d">3D</TabsTrigger>
              <TabsTrigger value="2d">2D план</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="3d" className="flex-1 mt-0" style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
              <div style={{ flex: 1 }}><ThreeDViewer /></div>
              <SpaceInspector />
            </div>
          </TabsContent>

          <TabsContent value="2d" className="flex-1 mt-0" style={{ overflow: 'hidden', position: 'relative' }}>
            <FloorPlanEditor />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
