"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

interface Viewer3DProps {
  glbUrl?: string
}

export default function Viewer3D({ glbUrl }: Viewer3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x162d4a);
    scene.fog = new THREE.FogExp2(0x162d4a, 0.02);

    // Camera
    const camera = new THREE.PerspectiveCamera(60, mount.clientWidth / mount.clientHeight, 0.01, 100);
    camera.position.set(0, 5, 8);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Grid helper (plancher)
    const grid = new THREE.GridHelper(20, 40, 0x1e3a5f, 0x1e3a5f);
    (grid.material as THREE.Material).opacity = 0.3;
    (grid.material as THREE.Material).transparent = true;
    scene.add(grid);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1;
    controls.maxDistance = 30;

    // Load GLB if provided, otherwise show demo box
    if (glbUrl) {
      const loader = new GLTFLoader();
      loader.load(glbUrl, (gltf) => {
        const model = gltf.scene;
        // Centre le modèle
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(center);
        scene.add(model);
        // Ajuste la caméra
        const size = box.getSize(new THREE.Vector3()).length();
        camera.position.set(0, size * 0.5, size * 1.2);
        controls.update();
      });
    } else {
      // Demo : boîte simple représentant une pièce
      const geo = new THREE.BoxGeometry(4, 2.5, 5);
      const mat = new THREE.MeshPhongMaterial({
        color: 0x3b82f6,
        wireframe: false,
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.15,
      });
      const box = new THREE.Mesh(geo, mat);
      box.position.y = 1.25;
      scene.add(box);

      // Contours des murs
      const edges = new THREE.EdgesGeometry(geo);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xF97316, linewidth: 2 });
      const wireframe = new THREE.LineSegments(edges, lineMat);
      wireframe.position.y = 1.25;
      scene.add(wireframe);

      // Label
      const canvas = document.createElement("canvas");
      canvas.width = 512; canvas.height = 128;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#F97316";
      ctx.font = "bold 32px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Scan demo — importez un .glb", 256, 64);
      const tex = new THREE.CanvasTexture(canvas);
      const labelGeo = new THREE.PlaneGeometry(4, 1);
      const labelMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
      const label = new THREE.Mesh(labelGeo, labelMat);
      label.position.set(0, 3.5, 0);
      label.lookAt(camera.position);
      scene.add(label);
    }

    // Animation loop
    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize
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
