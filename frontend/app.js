const API = "http://46.224.65.2:8123/analyze";

const el = (id) => document.getElementById(id);
const statusEl = el("status");

let chartIsthmus = null;
let chartArea = null;

function fmt(key, val) {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  const isMm3 = key.includes("_mm3");
  const isMm = key.includes("_mm");
  const isNorm = key.includes("_norm");
  const isPercent = key.includes("percent");
  if (isMm3) return `${val.toFixed(1)} mm³ (${(val/1000).toFixed(3)} cm³)`;
  if (isMm) return `${val.toFixed(2)} mm`;
  if (isNorm) return `${val.toFixed(3)}`;
  if (isPercent) return `${val.toFixed(2)}%`;
  if (typeof val === "number") return `${val.toFixed(3)}`;
  return String(val);
}

function fillTable(tableEl, obj, keys) {
  tableEl.innerHTML = "";
  keys.forEach(k => {
    const tr = document.createElement("tr");
    const tdK = document.createElement("td");
    tdK.className = "k";
    tdK.textContent = k;
    const tdV = document.createElement("td");
    tdV.className = "v";
    tdV.textContent = fmt(k, obj[k]);
    tr.appendChild(tdK);
    tr.appendChild(tdV);
    tableEl.appendChild(tr);
  });
}

function makeIsthmusChart(right, left) {
  const ctx = el("chartIsthmus").getContext("2d");
  chartIsthmus?.destroy();

  chartIsthmus = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Right", "Left"],
      datasets: [{
        label: "Isthmus position (normalized)",
        data: [right.istmo_position_norm, left.istmo_position_norm],
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true } },
      scales: {
        y: { min: 0, max: 1, title: { display: true, text: "0 → 1 along canal" } }
      }
    }
  });
}

function makeAreaChart(right, left) {
  const ctx = el("chartArea").getContext("2d");
  chartArea?.destroy();

  chartArea = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "Right A(s) (normalized)",
          data: right.s_norm.map((s, i) => ({ x: s, y: right.a_norm[i] })),
          borderWidth: 2,
          pointRadius: 0,
        },
        {
          label: "Left A(s) (normalized)",
          data: left.s_norm.map((s, i) => ({ x: s, y: left.a_norm[i] })),
          borderWidth: 2,
          pointRadius: 0,
          borderDash: [6, 4]
        }
      ]
    },
    options: {
      responsive: true,
      parsing: false,
      scales: {
        x: { type: "linear", min: 0, max: 1, title: { display: true, text: "normalized position" } },
        y: { min: 0, max: 1, title: { display: true, text: "normalized area" } }
      }
    }
  });
}

// --- 3D rendering (STL only) ---
function renderSTL(containerId, file) {
  const container = el(containerId);
  container.innerHTML = "";

  const THREE = window.THREE;
  const STLLoader = window.STLLoader;
  const OrbitControls = window.OrbitControls;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 2000);
  camera.position.set(0, 0, 180);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(1, 1, 1);
  scene.add(dir);

  const loader = new STLLoader();
  const reader = new FileReader();
  reader.onload = () => {
    const geometry = loader.parse(reader.result);

    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.9, transparent: true, opacity: 0.95 });
    const mesh = new THREE.Mesh(geometry, material);

    // center + scale
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);

    const center = new THREE.Vector3();
    box.getCenter(center);
    mesh.position.sub(center);

    const scale = 120 / maxDim;
    mesh.scale.setScalar(scale);

    scene.add(mesh);
  };
  reader.readAsArrayBuffer(file);

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // handle resize
  new ResizeObserver(() => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }).observe(container);
}

el("analyzeBtn").addEventListener("click", async () => {
  const fR = el("fileRight").files[0];
  const fL = el("fileLeft").files[0];

  if (!fR || !fL) {
    statusEl.textContent = "Upload both Right and Left meshes.";
    return;
  }

  statusEl.textContent = "Uploading + analyzing…";

  // 3D previews (STL only)
  if (fR.name.toLowerCase().endsWith(".stl")) renderSTL("viewerRight", fR);
  if (fL.name.toLowerCase().endsWith(".stl")) renderSTL("viewerLeft", fL);

  const fd = new FormData();
  fd.append("right", fR);
  fd.append("left", fL);

  const res = await fetch(API, { method: "POST", body: fd });
  const data = await res.json();

  if (!res.ok) {
    statusEl.textContent = data.error || "Error.";
    return;
  }

  statusEl.textContent = "Done.";

  const right = data.right;
  const left = data.left;
  const comp = data.comparison;

  const keysEar = [
    "volume_total_mm3",
    "volume_cartilaginous_mm3",
    "volume_bony_mm3",
    "istmo_position_mm",
    "istmo_position_norm",
    "canal_length_mm",
    "sections_used",
    "convergence_error_mm3",
    "convergence_error_cm3",
    "relative_error_percent"
  ];

  fillTable(el("tableRight"), right, keysEar);
  fillTable(el("tableLeft"), left, keysEar);

  const keysCmp = [
    "total_volume_diff_percent",
    "cartilaginous_volume_diff_percent",
    "bony_volume_diff_percent",
    "istmo_shift_mm",
    "istmo_shift_norm",
    "canal_length_diff_mm"
  ];
  fillTable(el("tableCompare"), comp, keysCmp);

  makeIsthmusChart(right, left);
  makeAreaChart(right, left);
});
