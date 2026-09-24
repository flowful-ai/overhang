"use client";

import React, { useEffect, useMemo, useState, useRef, useImperativeHandle, forwardRef, useCallback } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { RotateCcw, Grid3X3, Boxes, AlertTriangle } from "lucide-react";
import { BUILD_VOLUME_MM } from "@/lib/utils";
import { captureSnapshot } from "./chat/snapshot";

// OrbitControls ref: we only use these members so we type them explicitly.
interface OrbitControlsHandle {
  target: THREE.Vector3;
  maxDistance: number;
  update: () => void;
}

const BUILD_PLATE_SIZE = BUILD_VOLUME_MM; // mm (Bambu X1 / P1 default)

interface ThreeDViewerProps {
  stlBase64: string;
  // Identifies the design being shown. The camera re-frames when this changes
  // (a new design from the agent) but not when the same design re-renders
  // (e.g. a parameter slider), so the user's orbit isn't reset on every edit.
  frameKey?: string;
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

/** Place the bottom of the geometry at z=0 (on the build plate) and center it in X/Y. */
function placeOnBuildPlate(g: THREE.BufferGeometry) {
  g.computeBoundingBox();
  const bbox = g.boundingBox!;
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  g.translate(-center.x, -center.y, -bbox.min.z);
  g.computeBoundingBox();
  g.computeBoundingSphere();
}

/**
 * Decode and parse an STL straight from base64. Parsing in-process (rather
 * than useLoader on a blob URL) keeps geometries out of R3F's loader cache,
 * which holds one never-evicted entry per URL: every render leaked one.
 */
function parseStl(stlBase64: string): THREE.BufferGeometry {
  const binary = window.atob(stlBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const g = new STLLoader().parse(bytes.buffer);
  placeOnBuildPlate(g);
  g.computeVertexNormals();
  return g;
}

function Model({ geometry, wireframe }: {
  geometry: THREE.BufferGeometry;
  wireframe?: boolean;
}) {
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

/**
 * Size the clip planes and zoom-out limit to the model, so a large model isn't
 * cut by a fixed far plane. The build plate is always in the scene, so it sets
 * a floor on the extent.
 */
function fitClipping(camera: THREE.PerspectiveCamera, controls: OrbitControlsHandle | null, radius: number) {
  const extent = Math.max(radius, BUILD_PLATE_SIZE / 2);
  camera.near = Math.max(radius / 100, 0.01);
  camera.far = extent * 40;
  camera.updateProjectionMatrix();
  if (controls) controls.maxDistance = extent * 10;
}

function CameraController({ geometry, frameKey, controlsRef, resetRef }: {
  geometry: THREE.BufferGeometry;
  frameKey?: string;
  controlsRef: React.RefObject<OrbitControlsHandle | null>;
  resetRef: React.MutableRefObject<(() => void) | null>;
}) {
  const camera = useThree(s => s.camera) as THREE.PerspectiveCamera;
  const size = useThree(s => s.size);
  const invalidate = useThree(s => s.invalidate);

  // Bounding sphere of the model (mm); placeOnBuildPlate computed it.
  const sphere = useMemo(() => {
    const s = geometry.boundingSphere!.clone();
    s.radius = Math.max(s.radius, 0.5);
    return s;
  }, [geometry]);

  useEffect(() => {
    fitClipping(camera, controlsRef.current, sphere.radius);
    invalidate();
  }, [sphere, camera, controlsRef, invalidate]);

  const frameIso = useCallback(() => {
    // Fit the bounding sphere in the NARROWER of the two FOVs: on a portrait
    // (mobile) viewport the horizontal FOV is the limiting one.
    const vFov = camera.fov * (Math.PI / 180);
    const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const fitFov = Math.min(vFov, hFov);
    // 1.2x leaves room for the overlays (parameters, gizmo, dimensions).
    const distance = (sphere.radius / Math.sin(fitFov / 2)) * 1.2;
    const dir = new THREE.Vector3(1, 1, 1).normalize();
    camera.position.copy(sphere.center).add(dir.multiplyScalar(distance));
    camera.up.set(0, 0, 1);
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();

    if (controlsRef.current) {
      controlsRef.current.target.copy(sphere.center);
      controlsRef.current.update();
    }
    invalidate();
  }, [sphere, camera, size, controlsRef, invalidate]);

  // Frame on the first model and whenever the design changes (frameKey), but
  // NOT when the same design re-renders: a parameter tweak must not snap the
  // user's orbit back to iso. R/F and the reset button re-frame explicitly.
  // Assigning the ref in an effect keeps it off the render path.
  // The camera is part of the check because drei's <PerspectiveCamera
  // makeDefault> only replaces R3F's initial camera after the first commit.
  const framedRef = useRef<{ key: string; camera: THREE.Camera } | null>(null);
  useEffect(() => {
    resetRef.current = frameIso;
    // A viewer mounted inside a hidden pane (the inactive mobile tab) has no
    // size yet; wait for a real aspect ratio before the initial framing.
    if (size.width === 0 || size.height === 0) return;
    const key = frameKey ?? "";
    if (framedRef.current?.key === key && framedRef.current.camera === camera) return;
    framedRef.current = { key, camera };
    frameIso();
  }, [frameIso, frameKey, resetRef, size, camera]);

  return null;
}

// With frameloop="demand", R3F only draws when OrbitControls fires a change
// event. Toggling wireframe/grid from React state won't redraw on its own,
// so this component calls invalidate() whenever the watched props change.
function FrameInvalidator({ wireframe, showGrid, geometry }: {
  wireframe: boolean; showGrid: boolean; geometry: THREE.BufferGeometry;
}) {
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => { invalidate(); }, [invalidate, wireframe, showGrid, geometry]);
  return null;
}

const ThreeDViewer = forwardRef<ThreeDViewerRef, ThreeDViewerProps>(({ stlBase64, frameKey }, ref) => {
  const [wireframe, setWireframe] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const glRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControlsHandle>(null);
  const resetCameraRef = useRef<(() => void) | null>(null);

  const geometry = useMemo(() => parseStl(stlBase64), [stlBase64]);
  useEffect(() => () => { geometry.dispose(); }, [geometry]);

  const dimensions = useMemo<Dimensions>(() => {
    const size = new THREE.Vector3();
    geometry.boundingBox!.getSize(size);
    return {
      x: Number(size.x.toFixed(1)),
      y: Number(size.y.toFixed(1)),
      z: Number(size.z.toFixed(1)),
    };
  }, [geometry]);
  const exceedsBuildVolume = Math.max(dimensions.x, dimensions.y, dimensions.z) > BUILD_VOLUME_MM;

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

  // Keyboard shortcuts. Skipped when focus is in a text input.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }

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
  }, []);

  return (
    <div className="h-full w-full bg-gray-50 dark:bg-gray-900 rounded-lg overflow-hidden relative">
      <Canvas
        shadows="percentage"
        frameloop="demand"
        gl={{ preserveDrawingBuffer: true }}
        onCreated={({ gl }) => { glRef.current = gl; }}
      >
        <PerspectiveCamera makeDefault up={[0, 0, 1]} position={[100, 100, 100]} fov={50} />
        <group dispose={null}>
          <FrameInvalidator wireframe={wireframe} showGrid={showGrid} geometry={geometry} />
          <Model geometry={geometry} wireframe={wireframe} />
          <CameraController
            geometry={geometry}
            frameKey={frameKey}
            controlsRef={controlsRef}
            resetRef={resetCameraRef}
          />
          <OrbitControls ref={controlsRef as React.RefObject<never>} makeDefault />
          {/* Z-up scene: the hemisphere's "sky" is +Z, and the key light sits
              high above the model on the default iso-view side so top faces
              are lit instead of near-black. */}
          <hemisphereLight args={["#ffffff", "#8a8f99", 0.6]} position={[0, 0, 1]} />
          <ambientLight intensity={0.25} />
          <directionalLight
            position={[60, -80, 150]}
            intensity={1.1}
            castShadow
            shadow-mapSize-width={1024}
            shadow-mapSize-height={1024}
          />
          <directionalLight position={[-80, 60, 40]} intensity={0.35} />
          {showGrid && <BuildPlate />}
          {/* Margin pushes the gizmo below the floating Snapshot/Export buttons (~56px tall + spacing). */}
          <GizmoHelper alignment="top-right" margin={[56, 116]}>
            <GizmoViewport axisColors={["#ef4444", "#22c55e", "#3b82f6"]} labelColor="white" />
          </GizmoHelper>
        </group>
      </Canvas>

      {/* Dimensions display */}
      <div className="absolute bottom-4 left-4 bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm rounded-lg px-3 py-2 text-xs border border-gray-200 dark:border-gray-800 shadow-sm font-mono">
        <div className="text-gray-500 dark:text-gray-400 font-sans font-medium mb-1">Dimensions (mm)</div>
        <div className="flex gap-3 text-gray-700 dark:text-gray-200">
          <span>X: {dimensions.x}</span>
          <span>Y: {dimensions.y}</span>
          <span>Z: {dimensions.z}</span>
        </div>
        {exceedsBuildVolume && (
          <div className="mt-1 flex items-center gap-1 font-sans font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden />
            <span>Exceeds {BUILD_VOLUME_MM} mm build volume</span>
          </div>
        )}
      </div>

      {/* Controls hint - stays visible once a model is available. Hidden on
          touch devices (none of the mouse/keyboard hints apply) and on
          viewports too narrow to fit it without colliding with the
          dimensions box (UX audit #11, #13). */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 hidden sm:[@media(hover:hover)_and_(pointer:fine)]:flex items-center gap-3 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm rounded-lg px-3 py-1.5 text-[11px] text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-800 shadow-sm select-none whitespace-nowrap">
        <span><kbd className="font-mono text-gray-700 dark:text-gray-200">Drag</kbd> rotate</span>
        <span className="text-gray-300 dark:text-gray-600">•</span>
        <span><kbd className="font-mono text-gray-700 dark:text-gray-200">Right-drag</kbd> pan</span>
        <span className="text-gray-300 dark:text-gray-600">•</span>
        <span><kbd className="font-mono text-gray-700 dark:text-gray-200">Scroll</kbd> zoom</span>
        <span className="text-gray-300 dark:text-gray-600">•</span>
        <span><kbd className="font-mono text-gray-700 dark:text-gray-200">R</kbd>/<kbd className="font-mono text-gray-700 dark:text-gray-200">W</kbd>/<kbd className="font-mono text-gray-700 dark:text-gray-200">G</kbd></span>
      </div>

      {/* Viewer controls */}
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
    </div>
  );
});

ThreeDViewer.displayName = 'ThreeDViewer';

export default ThreeDViewer;
