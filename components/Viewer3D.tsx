"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

interface Viewer3DProps {
  glbUrl?: string;
  lazUrl?: string;
}

// Loaders loaders.gl chargés dynamiquement depuis esm.sh : absents du
// package.json (dépendances lourdes) et nécessaires uniquement côté client.
const LOADERS_CORE_URL = "https://esm.sh/@loaders.gl/core@4.2.0";
const LOADERS_LAS_URL = "https://esm.sh/@loaders.gl/las@4.2.0";

export default function Viewer3D({ glbUrl, lazUrl }: Viewer3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x162d4a);
    const fog = new THREE.FogExp2(0x162d4a, 0.02);
    scene.fog = fog;

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

    let disposed = false;

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
    } else if (!lazUrl) {
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

    if (lazUrl) {
      void loadLaz(lazUrl);
    }

    async function loadLaz(url: string) {
      try {
        const [core, las] = await Promise.all([
          import(LOADERS_CORE_URL),
          import(LOADERS_LAS_URL),
        ]);
        // fp64 obligatoire : coordonnées UTM (northing ~5 000 000 m) — en
        // Float32 l ulp vaut 0,5 m → nuage quantifié en lanières (fix PickInSitu)
        const data = await core.parse(
          await fetch(url).then((r) => r.arrayBuffer()),
          las.LASLoader,
          { las: { fp64: true } },
        );

        const pos = data.attributes?.POSITION?.value as ArrayLike<number> | undefined;
        const n = pos ? Math.floor(pos.length / 3) : 0;
        if (!n || !pos) {
          console.error("Nuage de points vide ou illisible :", url);
          return;
        }

        // Centroid (E, N, alt)
        let cE = 0;
        let cN = 0;
        let cZ = 0;
        for (let i = 0; i < n; i++) {
          cE += pos[3 * i];
          cN += pos[3 * i + 1];
          cZ += pos[3 * i + 2];
        }
        cE /= n;
        cN /= n;
        cZ /= n;

        // Échantillonnage si > ~500 000 points : garder 1 point sur step
        const step = n > 500000 ? Math.ceil(n / 500000) : 1;
        const count = Math.floor(n / step);

        // Centrage local + axes scène : x = E - cE, y = alt - cZ, z = -(N - cN)
        const local = new Float32Array(count * 3);
        for (let i = 0, j = 0; i < n && j < count; i += step, j++) {
          local[3 * j] = pos[3 * i] - cE;
          local[3 * j + 1] = pos[3 * i + 2] - cZ;
          local[3 * j + 2] = -(pos[3 * i + 1] - cN);
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(local, 3));

        // Couleur si COLOR_0 (normalisée 0-255 / 0-65535)
        const col = data.attributes?.COLOR_0?.value as ArrayLike<number> | undefined;
        let hasColor = false;
        if (col) {
          const cSize = data.attributes.COLOR_0.size || 3;
          if (col.length >= n * cSize) {
            let max = 0;
            for (let i = 0; i < col.length; i++) {
              if (col[i] > max) max = col[i];
            }
            const div = max > 255 ? 65535 : 255;
            const colorAttr = new Float32Array(count * 3);
            for (let i = 0, j = 0; i < n && j < count; i += step, j++) {
              colorAttr[3 * j] = col[cSize * i] / div;
              colorAttr[3 * j + 1] = col[cSize * i + 1] / div;
              colorAttr[3 * j + 2] = col[cSize * i + 2] / div;
            }
            geom.setAttribute("color", new THREE.BufferAttribute(colorAttr, 3));
            hasColor = true;
          }
        }

        const mat = new THREE.PointsMaterial({
          size: 0.05,
          sizeAttenuation: true,
          vertexColors: hasColor,
          color: hasColor ? 0xffffff : 0x93c5fd,
        });
        const points = new THREE.Points(geom, mat);

        if (disposed) {
          geom.dispose();
          mat.dispose();
          return;
        }
        scene.add(points);

        // Recentrage caméra / target sur le nuage (Box3 sur les positions centrées)
        const box = new THREE.Box3().setFromArray(local);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        const dist = Math.max(size * 1.2, 2);

        // Brume et plans calibrés pour une scène ~10 m ; sur un nuage de
        // centaines de mètres on les adapte sinon tout est masqué.
        fog.density = Math.min(fog.density, 0.8 / dist);
        camera.far = Math.max(camera.far, dist * 5);
        camera.updateProjectionMatrix();
        controls.maxDistance = Math.max(controls.maxDistance, dist * 4);
        controls.target.copy(center);
        camera.position.copy(center).add(new THREE.Vector3(size * 0.5, size * 0.5, dist));
        controls.update();
      } catch (err) {
        console.error("Échec du chargement du nuage de points :", err);
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
      disposed = true;
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [glbUrl, lazUrl]);

  return <div ref={mountRef} className="w-full h-full" />;
}
