from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
import trimesh
import shapely.geometry as geom

app = Flask(__name__)
CORS(app)

def volume_with_n_sections(mesh, n_sections=80):
    pts = mesh.vertices
    center = pts.mean(axis=0)

    _, _, Vt = np.linalg.svd(pts - center)
    axis = Vt[0]
    axis = axis / np.linalg.norm(axis)

    proj = (pts - center) @ axis
    s_vals = np.linspace(proj.min(), proj.max(), n_sections)

    areas, s_used = [], []
    for s in s_vals:
        sl = mesh.section(plane_origin=center + s * axis, plane_normal=axis)
        if sl is None:
            continue
        pts3d = sl.vertices
        if len(pts3d) < 10:
            continue

        poly = geom.MultiPoint(pts3d[:, :2]).convex_hull
        if poly.is_valid and poly.area > 0:
            areas.append(poly.area)
            s_used.append(s)

    if len(s_used) < 10:
        return None

    areas = np.array(areas)
    s_used = np.array(s_used)

    V_total = np.trapz(areas, s_used)

    # robust local isthmus: ignore ends
    valid = (s_used > np.percentile(s_used, 10)) & (s_used < np.percentile(s_used, 90))
    idx = np.argmin(areas[valid])
    s_ist = s_used[valid][idx]

    length = (proj.max() - proj.min())
    s_norm = (s_used - s_used.min()) / (s_used.max() - s_used.min())
    a_norm = areas / areas.max()

    return {
        "volume_total_mm3": float(V_total),
        "istmo_position_mm": float(s_ist),
        "istmo_position_norm": float((s_ist - proj.min()) / length) if length > 0 else float("nan"),
        "canal_length_mm": float(length),
        "s_norm": s_norm.tolist(),
        "a_norm": a_norm.tolist(),
        "sections_used": int(len(s_used))
    }

def analyze_ear(mesh, n_sections=80, split_percentile=65):
    res = volume_with_n_sections(mesh, n_sections=n_sections)
    if res is None:
        return None

    # recompute areas/s_used for outer/inner split (reuse same approach)
    pts = mesh.vertices
    center = pts.mean(axis=0)
    _, _, Vt = np.linalg.svd(pts - center)
    axis = Vt[0] / np.linalg.norm(Vt[0])
    proj = (pts - center) @ axis
    s_vals = np.linspace(proj.min(), proj.max(), n_sections)

    areas, s_used = [], []
    for s in s_vals:
        sl = mesh.section(plane_origin=center + s * axis, plane_normal=axis)
        if sl is None:
            continue
        pts3d = sl.vertices
        if len(pts3d) < 10:
            continue
        poly = geom.MultiPoint(pts3d[:, :2]).convex_hull
        if poly.is_valid and poly.area > 0:
            areas.append(poly.area)
            s_used.append(s)

    areas = np.array(areas)
    s_used = np.array(s_used)

    s_split = np.percentile(s_used, split_percentile)
    mask_outer = s_used < s_split
    mask_inner = s_used >= s_split

    V_outer = float(np.trapz(areas[mask_outer], s_used[mask_outer])) if mask_outer.any() else 0.0
    V_inner = float(np.trapz(areas[mask_inner], s_used[mask_inner])) if mask_inner.any() else 0.0

    # convergence estimate
    v_a = volume_with_n_sections(mesh, n_sections=80)
    v_b = volume_with_n_sections(mesh, n_sections=120)
    if v_a and v_b:
        err = abs(v_b["volume_total_mm3"] - v_a["volume_total_mm3"])
        rel = (err / v_a["volume_total_mm3"]) * 100 if v_a["volume_total_mm3"] else None
    else:
        err, rel = None, None

    res.update({
        "volume_cartilaginous_mm3": V_outer,
        "volume_bony_mm3": V_inner,
        "convergence_error_mm3": float(err) if err is not None else None,
        "convergence_error_cm3": float(err/1000) if err is not None else None,
        "relative_error_percent": float(rel) if rel is not None else None
    })
    return res

def load_mesh_from_upload(file_storage):
    data = file_storage.read()
    # trimesh can load from file-like
    import io
    bio = io.BytesIO(data)
    mesh = trimesh.load(bio, file_type=file_storage.filename.split(".")[-1], force="mesh", skip_materials=True, maintain_order=False)

    # optional: decimate a bit to keep performance stable
    # comment out if you want raw
    try:
        target = int(len(mesh.faces) * 0.05)
        if target > 5000:
            mesh = mesh.simplify_quadric_decimation(target)
            mesh.remove_unreferenced_vertices()
            mesh.remove_degenerate_faces()
    except Exception:
        pass

    return mesh

@app.post("/analyze")
def analyze():
    right_file = request.files.get("right")
    left_file = request.files.get("left")
    if not right_file or not left_file:
        return jsonify({"error": "Upload both right and left files (form fields: right, left)."}), 400

    right_mesh = load_mesh_from_upload(right_file)
    left_mesh = load_mesh_from_upload(left_file)

    right = analyze_ear(right_mesh)
    left = analyze_ear(left_mesh)

    if right is None or left is None:
        return jsonify({"error": "Could not compute profiles (too few valid sections). Try less decimation or different mesh."}), 400

    def pct_diff(a, b):
        return 100.0 * (b - a) / a if a else None

    comparison = {
        "total_volume_diff_percent": pct_diff(right["volume_total_mm3"], left["volume_total_mm3"]),
        "cartilaginous_volume_diff_percent": pct_diff(right["volume_cartilaginous_mm3"], left["volume_cartilaginous_mm3"]),
        "bony_volume_diff_percent": pct_diff(right["volume_bony_mm3"], left["volume_bony_mm3"]),
        "istmo_shift_mm": left["istmo_position_mm"] - right["istmo_position_mm"],
        "istmo_shift_norm": left["istmo_position_norm"] - right["istmo_position_norm"],
        "canal_length_diff_mm": left["canal_length_mm"] - right["canal_length_mm"],
    }

    return jsonify({
        "right": right,
        "left": left,
        "comparison": comparison
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
