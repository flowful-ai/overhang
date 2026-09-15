"use client";

import React, { useEffect, useMemo, useState, useRef, useImperativeHandle, forwardRef, Suspense, useCallback } from "react";
import { Canvas, useLoader, useThree } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { Loader2, RotateCcw, Grid3X3, Boxes } from "lucide-react";
import { base64ToObjectUrl, APP_CONSTANTS, BUILD_VOLUME_MM } from "@/lib/utils";
import { captureSnapshot } from "./chat/snapshot";

// OrbitControls ref: we only use .target and .update() so we type those explicitly.
interface OrbitControlsHandle {
  target: THREE.Vector3;
  update: () => void;
}

const BUILD_PLATE_SIZE = BUILD_VOLUME_MM; // mm (Bambu X1 / P1 default)

interface ThreeDViewerProps {
  stlBase64?: string;
  // Replaces the default placeholder when there is no STL (e.g. a restored
  // session that is re-rendering its model).
  emptyState?: React.ReactNode;
}

export interface ThreeDViewerRef {
  takeSnapshot: () => string | null;
  resetCamera: () => void;
}

interface Dimensions {
  x: number;
  y: number;
  z: number;
}

function LoadingFallback() {
  return (
    <mesh>
      <boxGeometry args={[0.5, 0.5, 0.5]} />
      <meshStandardMaterial color="#e5e7eb" wireframe />
    </mesh>
  );
}

/** Place the bottom of the geometry at z=0 (on the build plate) and center it in X/Y. */
function placeOnBuildPlate(g: THREE.BufferGeometry) {
  g.computeBoundingBox();
  const bbox = g.boundingBox!;
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  g.translate(-center.x, -center.y, -bbox.min.z);
  g.computeBoundingBox();
}

function Model({ url, wireframe, onLoaded }: {
  url: string;
  wireframe?: boolean;
  onLoaded?: (geometry: THREE.BufferGeometry) => void;
}) {
  const rawGeometry = useLoader(STLLoader, url);

  const geometry = useMemo(() => {
    const g = rawGeometry.clone();
    placeOnBuildPlate(g);
    g.computeVertexNormals();
    return g;
  }, [rawGeometry]);

  useEffect(() => {
    if (onLoaded) onLoaded(geometry);
  }, [geometry, onLoaded]);

  useEffect(() => {
    return () => { geometry.dispose(); };
  }, [geometry]);

  // Dispose the raw loader geometry too; R3F's loader cache would otherwise
  // retain GPU buffers across many STL generations.
  useEffect(() => {
    return () => { rawGeometry.dispose(); };
  }, [rawGeometry]);

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial
        color="#3b82f6"
        roughness={0.4}
        metalness={0.1}
        wireframe={wireframe}
      />
    </mesh>
  );
}

/**
 * Bounded build-plate grid (a fixed-size square at z=0) instead of an infinite plane.
 * Helps show scale relative to a typical 3D printer bed.
 */
function BuildPlate({ size = BUILD_PLATE_SIZE }: { size?: number }) {
  return (
    <group position={[0, 0, 0]}>
      {/* 5mm grid: legible at normal zoom, ~4x lighter than per-mm */}
      <gridHelper
        args={[size, size / 5, "#c0c0c0", "#d8d8d8"]}
        rotation={[Math.PI / 2, 0, 0]}
        position={[0, 0, 0.001]}
      />
      {/* 10mm sections on top for readability */}
      <gridHelper
        args={[size, size / 10, "#8a8a8a", "#a8a8a8"]}
        rotation={[Math.PI / 2, 0, 0]}
        position={[0, 0, 0.002]}
      />
      {/* Subtle plate background so the grid has contrast. planeGeometry is
          already in the XY plane facing +Z, which is "flat on the floor" in
          this Z-up scene — no rotation (the gridHelpers above DO need one:
          gridHelper is XZ-native, three.js Y-up convention). */}
      <mesh position={[0, 0, -0.001]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color="#f5f5f5" roughness={1} />
      </mesh>
    </group>
  );
}

function CameraController({ geometry, controlsRef, resetRef }: {
  geometry: THREE.BufferGeometry | null;
  controlsRef: React.RefObject<OrbitControlsHandle | null>;
  resetRef: React.MutableRefObject<(() => void) | null>;
}) {
  const { camera } = useThree();

  const frameIso = useCallback(() => {
    if (!geometry) return;
    const bbox = geometry.boundingBox;
    if (!bbox) return;

    const size = new THREE.Vector3();
    bbox.getSize(size);
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z, 1);

    const persp = camera as THREE.PerspectiveCamera;
    const fov = persp.fov * (Math.PI / 180);
    const distance = maxDim / (2 * Math.tan(fov / 2)) * 2.5;
    const dir = new THREE.Vector3(1, 1, 1).normalize();
    camera.position.copy(center).add(dir.multiplyScalar(distance));
    camera.up.set(0, 0, 1);
    camera.lookAt(center);
    persp.updateProjectionMatrix();

    if (controlsRef.current) {
      controlsRef.current.target.copy(center);
      controlsRef.current.update();
    }
  }, [geometry, camera, controlsRef]);

  // Expose the framing callback to the parent and frame on first paint /
  // whenever the geometry (and thus frameIso) changes. Assigning the ref in an
  // effect rather than during render keeps it off the render path.
  useEffect(() => {
    resetRef.current = frameIso;
    frameIso();
  }, [frameIso, resetRef]);

  return null;
}

// With frameloop="demand", R3F only draws when OrbitControls fires a change
// event. Toggling wireframe/grid from React state won't redraw on its own,
// so this component calls invalidate() whenever the watched props change.
function FrameInvalidator({ wireframe, showGrid, geometry }: {
  wireframe: boolean; showGrid: boolean; geometry: THREE.BufferGeometry | null;
}) {
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => { invalidate(); }, [invalidate, wireframe, showGrid, geometry]);
  return null;
}

const ThreeDViewer = forwardRef<ThreeDViewerRef, ThreeDViewerProps>(({ stlBase64, emptyState }, ref) => {
  const [stlUrl, setStlUrl] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [dimensions, setDimensions] = useState<Dimensions | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const glRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControlsHandle>(null);
  const resetCameraRef = useRef<(() => void) | null>(null);

  const handleModelLoaded = useCallback((geo: THREE.BufferGeometry) => {
    setGeometry(geo);
    setIsLoading(false);
    const bbox = geo.boundingBox;
    if (bbox) {
      const size = new THREE.Vector3();
      bbox.getSize(size);
      setDimensions({
        x: Number(size.x.toFixed(1)),
        y: Number(size.y.toFixed(1)),
        z: Number(size.z.toFixed(1)),
      });
    }
  }, []);

  useImperativeHandle(ref, () => ({
    takeSnapshot: () => {
      if (glRef.current) {
        // Downscaled JPEG: a full-resolution PNG is megabytes per turn.
        return captureSnapshot(glRef.current.domElement);
      }
      return null;
    },
    resetCamera: () => {
      resetCameraRef.current?.();
    },
  }));

  useEffect(() => {
    if (stlBase64) {
      const url = base64ToObjectUrl(stlBase64, APP_CONSTANTS.STL_MIME_TYPE);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- this effect owns the object-URL lifecycle (revoked in cleanup); syncing state to the stlBase64 prop is its purpose
      setStlUrl(url);
      setIsLoading(true);
      setDimensions(null);

      return () => {
        URL.revokeObjectURL(url);
      };
    } else {
      setStlUrl(null);
      setGeometry(null);
      setDimensions(null);
      setIsLoading(false);
    }
  }, [stlBase64]);

  // Keyboard shortcuts. Skipped when focus is in a text input.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      if (!geometry) return;

      switch (e.key.toLowerCase()) {
        case "r":
        case "f":
          resetCameraRef.current?.();
          break;
        case "w":
          setWireframe(v => !v);
          break;
        case "g":
          setShowGrid(v => !v);
          break;
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [geometry]);

  if (!stlUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900 text-gray-400 dark:text-gray-400">
        {emptyState ?? <p>Your 3D design will appear here</p>}
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-gray-50 dark:bg-gray-900 rounded-lg overflow-hidden relative">
      <Canvas
        shadows="percentage"
        frameloop="demand"
        gl={{ preserveDrawingBuffer: true }}
        onCreated={({ gl }) => { glRef.current = gl; }}
      >
        <PerspectiveCamera makeDefault up={[0, 0, 1]} position={[100, 100, 100]} fov={50} />
        <Suspense fallback={<LoadingFallback />}>
          <group dispose={null}>
            <FrameInvalidator wireframe={wireframe} showGrid={showGrid} geometry={geometry} />
            <Model url={stlUrl} wireframe={wireframe} onLoaded={handleModelLoaded} />
            <CameraController
              geometry={geometry}
              controlsRef={controlsRef}
              resetRef={resetCameraRef}
            />
            <OrbitControls ref={controlsRef as React.RefObject<never>} makeDefault />
            <ambientLight intensity={0.5} />
            <directionalLight
              position={[50, 100, 50]}
              intensity={0.8}
              castShadow
              shadow-mapSize-width={1024}
              shadow-mapSize-height={1024}
            />
            <directionalLight position={[-50, 50, -50]} intensity={0.3} />
            {showGrid && <BuildPlate />}
            {/* Margin pushes the gizmo below the floating Snapshot/Export buttons (~56px tall + spacing). */}
            <GizmoHelper alignment="top-right" margin={[56, 116]}>
              <GizmoViewport axisColors={["#ef4444", "#22c55e", "#3b82f6"]} labelColor="white" />
            </GizmoHelper>
          </group>
        </Suspense>
      </Canvas>

      {/* Loading overlay */}
      {isLoading && (
        <div role="status" aria-live="polite" className="absolute inset-0 flex items-center justify-center bg-gray-50/80 dark:bg-gray-900/80 pointer-events-none">
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
            <span className="text-sm">Loading model...</span>
          </div>
        </div>
      )}

      {/* Dimensions display */}
      {dimensions && (
        <div className="absolute bottom-4 left-4 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm rounded-lg px-3 py-2 text-xs border border-gray-200 dark:border-gray-800 shadow-sm font-mono">
          <div className="text-gray-500 dark:text-gray-400 font-sans font-medium mb-1">Dimensions (mm)</div>
          <div className="flex gap-3 text-gray-700 dark:text-gray-200">
            <span>X: {dimensions.x}</span>
            <span>Y: {dimensions.y}</span>
            <span>Z: {dimensions.z}</span>
          </div>
        </div>
      )}

      {/* Controls hint - stays visible once a model is available. Hidden on
          touch devices (none of the mouse/keyboard hints apply) and on
          viewports too narrow to fit it without colliding with the
          dimensions box (UX audit #11, #13). */}
      {geometry && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 hidden sm:[@media(hover:hover)_and_(pointer:fine)]:flex items-center gap-3 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm rounded-lg px-3 py-1.5 text-[11px] text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-800 shadow-sm select-none whitespace-nowrap">
          <span><kbd className="font-mono text-gray-700 dark:text-gray-200">Drag</kbd> rotate</span>
          <span className="text-gray-300 dark:text-gray-600">•</span>
          <span><kbd className="font-mono text-gray-700 dark:text-gray-200">Right-drag</kbd> pan</span>
          <span className="text-gray-300 dark:text-gray-600">•</span>
          <span><kbd className="font-mono text-gray-700 dark:text-gray-200">Scroll</kbd> zoom</span>
          <span className="text-gray-300 dark:text-gray-600">•</span>
          <span><kbd className="font-mono text-gray-700 dark:text-gray-200">R</kbd>/<kbd className="font-mono text-gray-700 dark:text-gray-200">W</kbd>/<kbd className="font-mono text-gray-700 dark:text-gray-200">G</kbd></span>
        </div>
      )}

      {/* Viewer controls */}
      {geometry && (
        <div className="absolute bottom-12 right-4 flex gap-1.5">
          <button
            onClick={() => setShowGrid(v => !v)}
            className={`p-2 rounded-lg border text-xs transition-colors ${
              showGrid
                ? "bg-primary-50 dark:bg-primary-950/40 border-primary-200 dark:border-primary-800 text-primary-700 dark:text-primary-300"
                : "bg-white/90 dark:bg-gray-900/90 border-gray-200 dark:border-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
            title={showGrid ? "Hide build plate (G)" : "Show build plate (G)"}
          >
            <Grid3X3 className="w-4 h-4" />
          </button>
          <button
            onClick={() => setWireframe(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg border text-xs font-medium transition-colors ${
              wireframe
                ? "bg-primary-50 dark:bg-primary-950/40 border-primary-200 dark:border-primary-800 text-primary-700 dark:text-primary-300"
                : "bg-white/90 dark:bg-gray-900/90 border-gray-200 dark:border-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
            title={wireframe ? "Solid view (W)" : "Wireframe view (W)"}
          >
            <Boxes className="w-4 h-4" />
            Wire
          </button>
          <button
            onClick={() => resetCameraRef.current?.()}
            className="p-2 rounded-lg border bg-white/90 dark:bg-gray-900/90 border-gray-200 dark:border-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            title="Reset camera view (R)"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
});

ThreeDViewer.displayName = 'ThreeDViewer';

export default ThreeDViewer;
