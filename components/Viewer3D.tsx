"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

interface Viewer3DProps {
  glbUrl?: string;
}

export default function Viewer3D({ glbUrl }: Viewer3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x162d4a);
    scene.fog = new THREE.FogExp2(0x162d4a, 0.02);

    const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 0.01, 100);
    camera.position.set(0, 5, 8);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    const grid = new THREE.GridHelper(20, 40, 0x1e3a5f, 0x1e3a5f);
    (grid.material as THREE.Material).opacity = 0.3;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1;
    controls.maxDistance = 30;

    if (glbUrl) {
      const loader = new GLTFLoader();
      loader.load(glbUrl, (gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(center);
        scene.add(model);
        const size = box.getSize(new THREE.Vector3()).length();
        camera.position.set(0, size * 0.5, size * 1.2);
        controls.update();
      });
    } else {
      // Pièce de démonstration
      const roomGeo = new THREE.BoxGeometry(6, 2.7, 8);
      const roomMat = new THREE.MeshPhongMaterial({
        color: 0x3b82f6,
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.08,
      });
      const room = new THREE.Mesh(roomGeo, roomMat);
      room.position.y = 1.35;
      scene.add(room);

      const edges = new THREE.EdgesGeometry(roomGeo);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xF97316 });
      const wireframe = new THREE.LineSegments(edges, lineMat);
      wireframe.position.y = 1.35;
      scene.add(wireframe);

      // Simulation de meubles détectés
      const furniture = [
        { w: 1.8, h: 0.8, d: 0.9, x: -2, z: -2, color: 0x475569 },
        { w: 1.2, h: 0.75, d: 0.6, x: 1.5, z: -2.5, color: 0x64748b },
        { w: 0.6, h: 1.5, d: 0.4, x: -2.5, z: 1, color: 0x94a3b8 },
      ];
      for (const f of furniture) {
        const geo = new THREE.BoxGeometry(f.w, f.h, f.d);
        const mat = new THREE.MeshPhongMaterial({ color: f.color });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(f.x, f.h / 2, f.z);
        scene.add(mesh);
      }
    }

    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [glbUrl]);

  return <div ref={mountRef} className="w-full h-full" />;
}
