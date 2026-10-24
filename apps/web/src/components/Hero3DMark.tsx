"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import clsx from "clsx";
import { MoonMark } from "./MoonMark";
import { rowsOf } from "@/lib/mark";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

// Ported from the three.js IIFE at the end of moonshift_v2_source.html.
// See BRAND.md "3D hero mark". Falls back to MoonMark with no WebGL or with
// reduced motion, per CLAUDE_NOTES_3_FRONTEND.md's Hero3DMark row.
export function Hero3DMark() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [gl, setGl] = useState(false);
  const rm = usePrefersReducedMotion();

  useEffect(() => {
    if (rm) return; // fall back to the flat mark, no 3D setup at all
    const box = boxRef.current;
    if (!box) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return;
    }

    setGl(true);
    box.prepend(renderer.domElement);
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));

    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(28, 1, 1, 2000);
    cam.position.set(0, 0, 330);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d8d4, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(120, 160, 260);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.9);
    rim.position.set(-220, -60, 120);
    scene.add(rim);
    const grp = new THREE.Group();
    scene.add(grp);

    const readColor = (name: string, fallback: string) => {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    };
    const inkM = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(readColor("--ink", "#111113")),
      roughness: 0.38,
      metalness: 0,
      clearcoat: 0.7,
      clearcoatRoughness: 0.25,
    });
    const accM = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(readColor("--accent", "#ffc21a")),
      roughness: 0.42,
      metalness: 0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3,
    });
    const applyThemeColors = () => {
      inkM.color.set(readColor("--ink", "#111113"));
      accM.color.set(readColor("--accent", "#ffc21a"));
    };
    const themeObserver = new MutationObserver(applyThemeColors);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });

    const o = (y: number) => Math.sqrt(Math.max(0, 44 * 44 - (y - 50) ** 2));
    interface Piece {
      mesh: THREE.Mesh;
      z: number;
      ri: number;
      side: 1 | -1;
    }
    const pieces: Piece[] = [];
    const geometries: THREE.BufferGeometry[] = [];

    rowsOf(8).forEach((r, ri) => {
      const ys: number[] = [];
      for (let k = 0; k <= 10; k++) ys.push(r.y + (r.h * k) / 10);

      const mk = (L: (y: number) => number, R: (y: number) => number, mat: THREE.Material, z: number, side: 1 | -1) => {
        const pts = ys.map((y) => [L(y), R(y)] as [number, number]);
        if (pts.every(([a, b]) => b - a < 0.4)) return;
        const sh = new THREE.Shape();
        pts.forEach(([a], k) => {
          const p: [number, number] = [a - 54, 50 - ys[k]];
          k ? sh.lineTo(...p) : sh.moveTo(...p);
        });
        for (let k = pts.length - 1; k >= 0; k--) {
          sh.lineTo(Math.max(pts[k][0], pts[k][1]) - 54, 50 - ys[k]);
        }
        const geo = new THREE.ExtrudeGeometry(sh, {
          depth: 9,
          bevelEnabled: true,
          bevelThickness: 1.1,
          bevelSize: 0.7,
          bevelSegments: 4,
          curveSegments: 6,
        });
        geo.translate(0, 0, -4.5);
        geometries.push(geo);
        const m = new THREE.Mesh(geo, mat);
        grp.add(m);
        pieces.push({ mesh: m, z, ri, side });
      };

      mk(
        (y) => 50 - o(y),
        (y) => Math.min(50 + o(y), r.split - 1.6),
        inkM,
        0,
        -1
      );
      mk(
        (y) => Math.max(r.split + 1.6, 50 - o(y)) + 7,
        (y) => 50 + o(y) + 7,
        accM,
        7,
        1
      );
    });

    function size() {
      const w = box!.clientWidth;
      const h = box!.clientHeight;
      renderer.setSize(w, h, false);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
    size();
    addEventListener("resize", size);

    const t0 = performance.now();
    const ease = (x: number) => 1 - Math.pow(1 - x, 4);
    let raf = 0;
    let disposed = false;
    const floor = box.querySelector<HTMLElement>(".floor");

    // Slow float: rises and settles over ~5.2s. FLOAT is the peak lift in
    // scene units, used to normalize the shadow response.
    const FLOAT = 7;
    const FLOAT_SPEED = (2 * Math.PI) / 5.2;

    function frame(now: number) {
      if (disposed) return;
      const t = (now - t0) / 1000;
      pieces.forEach((p) => {
        const k = ease(Math.min(1, Math.max(0, (t - 0.15 - p.ri * 0.07 - (p.side > 0 ? 0.35 : 0)) / 1.1)));
        // After the intro settles, a slow wave runs down the crescent rows like
        // time passing through the schedule. Crescent only moves forward in z,
        // so the 7 unit gap in x never closes.
        const wave = p.side > 0 ? k * 3.5 * (0.5 + 0.5 * Math.sin(t * 0.9 - p.ri * 0.55)) : 0;
        p.mesh.position.z = p.z + (1 - k) * (p.side > 0 ? 60 : -40) + wave;
        p.mesh.position.x = (1 - k) * p.side * -24;
        p.mesh.scale.setScalar(0.6 + 0.4 * k);
      });
      // Float fades in once the intro has settled so there's no jump. It
      // starts at the bottom of its arc (lift 0) and rises from there.
      const on = Math.min(1, Math.max(0, (t - 1.8) / 1.2));
      const lift = on * FLOAT * 0.5 * (1 - Math.cos((t - 1.8) * FLOAT_SPEED));

      // Slow drift: out-of-phase sines so it never reads as a simple loop. A
      // touch of tilt follows the float, leaning back as it rises.
      grp.rotation.y = -0.38 + Math.sin(t * 0.21) * 0.2 + Math.sin(t * 0.53 + 1.1) * 0.05;
      grp.rotation.x = 0.1 + Math.sin(t * 0.17 + 1.3) * 0.07 - lift * 0.006;
      grp.rotation.z = Math.sin(t * 0.13 + 0.4) * 0.03;
      grp.position.y = lift;

      // Shadow tracks the mark: slides with the side-to-side drift, tilts
      // with the roll, and gets smaller and lighter as the mark rises.
      if (floor) {
        const air = lift / FLOAT;
        const sway = grp.rotation.y + 0.38; // drift around the resting angle
        const shift = sway * 45; // % of the shadow's own width
        const roll = grp.rotation.z * 60; // deg
        floor.style.transform = `translateX(${shift.toFixed(2)}%) rotate(${roll.toFixed(2)}deg) scaleX(${(1 - air * 0.22).toFixed(3)})`;
        floor.style.opacity = (1 - air * 0.45).toFixed(3);
      }
      renderer.render(scene, cam);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      themeObserver.disconnect();
      removeEventListener("resize", size);
      geometries.forEach((g) => g.dispose());
      inkM.dispose();
      accM.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [rm]);

  return (
    <div className={clsx("stage3d", gl && "gl")} ref={boxRef} id="stage3d">
      <div className="floor" />
      <MoonMark size={420} className="fallback" />
    </div>
  );
}
