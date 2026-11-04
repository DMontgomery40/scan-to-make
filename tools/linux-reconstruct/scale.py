"""Metric scale from camera-centre alignment (robust similarity / Sim3).

COLMAP reconstructions are in arbitrary units. When the capture app supplies
ARCore camera centres in metres for the same images, a similarity transform
(rotation, uniform scale, translation) between the two centre sets recovers
metres-per-unit. Writing metersPerUnit into a file proves nothing by itself:
this module only returns a scale when the fit is demonstrably good, and it
records coverage, spread, inliers and residuals so the receipt can show why.

Pure Python (3x3 problems only): Jacobi eigendecomposition of symmetric
matrices gives the SVD Umeyama's method needs.
"""
import math

# Fit gates. A walk-around of a tabletop object is ~0.3-2 m across as seen by
# the camera path; ARCore centre noise after bundle adjustment disagreement is
# typically well under 1% of path spread. 2% median / 5% p90 relative residual
# is generous for a genuine fit and far below what a wrong association gives.
MIN_MATCHED = 12
MIN_FRACTION_OF_TRACKING = 0.5      # of tracking frames that COLMAP registered
MIN_SPREAD_M = 0.15                 # camera path must actually move, in metres
MIN_SPREAD_UNITS_REL = 1e-9
MIN_PLANARITY = 0.02                # 2nd/1st eigenvalue ratio of centre scatter
INLIER_RESIDUAL_REL = 0.02          # residual <= 2% of spread counts as inlier
MIN_INLIER_FRACTION = 0.8
MAX_MEDIAN_RESIDUAL_REL = 0.02
MAX_P90_RESIDUAL_REL = 0.05
SCALE_MIN, SCALE_MAX = 1e-5, 1e5    # metres per COLMAP unit sanity bound


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _norm(a):
    return math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])


def _centroid(points):
    n = len(points)
    return tuple(sum(p[i] for p in points) / n for i in range(3))


def _mat_vec(m, v):
    return tuple(m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2] for r in range(3))


def _mat_mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(3)) for c in range(3)] for r in range(3)]


def _transpose(m):
    return [[m[c][r] for c in range(3)] for r in range(3)]


def _det(m):
    return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))


def jacobi_eigh(a):
    """Eigenpairs of a symmetric 3x3 matrix. Returns (values, vectors-as-columns)."""
    m = [row[:] for row in a]
    v = [[1.0 if r == c else 0.0 for c in range(3)] for r in range(3)]
    for _ in range(64):
        # Largest off-diagonal element.
        p, q, largest = 0, 1, abs(m[0][1])
        if abs(m[0][2]) > largest:
            p, q, largest = 0, 2, abs(m[0][2])
        if abs(m[1][2]) > largest:
            p, q, largest = 1, 2, abs(m[1][2])
        if largest < 1e-15:
            break
        theta = 0.5 * math.atan2(2.0 * m[p][q], m[q][q] - m[p][p]) if m[p][p] != m[q][q] else math.pi / 4
        c, s = math.cos(theta), math.sin(theta)
        for k in range(3):
            mkp, mkq = m[k][p], m[k][q]
            m[k][p] = c * mkp - s * mkq
            m[k][q] = s * mkp + c * mkq
        for k in range(3):
            mpk, mqk = m[p][k], m[q][k]
            m[p][k] = c * mpk - s * mqk
            m[q][k] = s * mpk + c * mqk
        for k in range(3):
            vkp, vkq = v[k][p], v[k][q]
            v[k][p] = c * vkp - s * vkq
            v[k][q] = s * vkp + c * vkq
    order = sorted(range(3), key=lambda i: -m[i][i])
    values = [m[i][i] for i in order]
    vectors = [[v[r][i] for i in order] for r in range(3)]
    return values, vectors


def scatter_eigenvalues(points):
    """Eigenvalues (descending) of the centred scatter matrix of points."""
    mu = _centroid(points)
    s = [[0.0] * 3 for _ in range(3)]
    for p in points:
        d = _sub(p, mu)
        for r in range(3):
            for c in range(3):
                s[r][c] += d[r] * d[c]
    values, _ = jacobi_eigh(s)
    return values


def umeyama(src, dst):
    """Least-squares similarity dst ~= scale * R * src + t. Returns (scale, R, t)."""
    n = len(src)
    mu_s, mu_d = _centroid(src), _centroid(dst)
    var_s = sum(_norm(_sub(p, mu_s)) ** 2 for p in src) / n
    if var_s <= 0:
        raise ValueError("source points are coincident")
    cov = [[0.0] * 3 for _ in range(3)]
    for ps, pd in zip(src, dst):
        ds, dd = _sub(ps, mu_s), _sub(pd, mu_d)
        for r in range(3):
            for c in range(3):
                cov[r][c] += dd[r] * ds[c] / n
    # SVD of cov via eigendecomposition of cov^T cov = V diag(sigma^2) V^T.
    ata = _mat_mul(_transpose(cov), cov)
    eigvals, v = jacobi_eigh(ata)
    sigma = [math.sqrt(max(ev, 0.0)) for ev in eigvals]
    u = [[0.0] * 3 for _ in range(3)]
    for k in range(3):
        if sigma[k] > 1e-15:
            col = _mat_vec(cov, (v[0][k], v[1][k], v[2][k]))
            for r in range(3):
                u[r][k] = col[r] / sigma[k]
    if sigma[2] <= 1e-15:  # complete U with a cross product so R stays proper
        a = (u[0][0], u[1][0], u[2][0])
        b = (u[0][1], u[1][1], u[2][1])
        cross = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
        for r in range(3):
            u[r][2] = cross[r]
    d = 1.0 if _det(_mat_mul(u, _transpose(v))) >= 0 else -1.0
    diag = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, d]]
    rotation = _mat_mul(_mat_mul(u, diag), _transpose(v))
    scale = (sigma[0] + sigma[1] + d * sigma[2]) / var_s
    t = _sub(mu_d, tuple(scale * x for x in _mat_vec(rotation, mu_s)))
    return scale, rotation, t


def apply_similarity(scale, rotation, translation, point):
    r = _mat_vec(rotation, point)
    return (scale * r[0] + translation[0], scale * r[1] + translation[1], scale * r[2] + translation[2])


def _percentile(sorted_vals, q):
    if not sorted_vals:
        return float("nan")
    idx = min(len(sorted_vals) - 1, max(0, math.ceil(q * len(sorted_vals)) - 1))
    return sorted_vals[idx]


def _spread(points):
    """RMS distance from centroid: the scale of the camera path."""
    mu = _centroid(points)
    return math.sqrt(sum(_norm(_sub(p, mu)) ** 2 for p in points) / len(points))


def fit_camera_scale(colmap_centres, metric_centres, tracking_total):
    """Robustly fit COLMAP centres (units) to ARCore centres (metres).

    Both lists are aligned by image. Returns a report dict; report["ok"] is
    True only when every gate passes, and then scale/rotation/translation
    map reconstruction coordinates to metres in the ARCore (Y-up) frame.
    One reweighting pass refits on inliers; gates are judged on all points.
    """
    report = {"ok": False, "method": "camera-centre-similarity",
              "matched": len(colmap_centres), "trackingFrames": tracking_total}
    n = len(colmap_centres)
    if n != len(metric_centres):
        report["reason"] = "centre lists are not aligned"
        return report
    if n < MIN_MATCHED:
        report["reason"] = f"only {n} registered tracking frames (need {MIN_MATCHED})"
        return report
    if tracking_total and n < MIN_FRACTION_OF_TRACKING * tracking_total:
        report["reason"] = "COLMAP registered too few of the tracking frames"
        return report
    spread_m = _spread(metric_centres)
    spread_u = _spread(colmap_centres)
    report["spreadM"] = round(spread_m, 6)
    report["spreadUnits"] = round(spread_u, 6)
    if spread_m < MIN_SPREAD_M:
        report["reason"] = "camera barely moved; centre alignment cannot establish scale"
        return report
    if spread_u <= MIN_SPREAD_UNITS_REL:
        report["reason"] = "reconstructed camera centres are coincident"
        return report
    eig = scatter_eigenvalues(metric_centres)
    planarity = eig[1] / eig[0] if eig[0] > 0 else 0.0
    report["planarityRatio"] = round(planarity, 6)
    if planarity < MIN_PLANARITY:
        report["reason"] = "camera path is nearly a straight line; alignment is ill-posed"
        return report
    try:
        scale, rotation, translation = umeyama(colmap_centres, metric_centres)
    except ValueError as e:
        report["reason"] = str(e)
        return report

    def residuals(s, r, t):
        return [_norm(_sub(apply_similarity(s, r, t, p), q))
                for p, q in zip(colmap_centres, metric_centres)]

    res = residuals(scale, rotation, translation)
    tol = INLIER_RESIDUAL_REL * spread_m
    # Robust refit: least squares smears a few bad centres over all residuals,
    # so select the refit set by median-relative residuals first. The final
    # gates below still judge every point against the strict tolerance.
    for _ in range(4):
        median = _percentile(sorted(res), 0.5)
        keep = [i for i, r in enumerate(res) if r <= max(tol, 3.0 * median)]
        if not (MIN_MATCHED <= len(keep) < n):
            break
        try:
            s2, r2, t2 = umeyama([colmap_centres[i] for i in keep],
                                 [metric_centres[i] for i in keep])
        except ValueError:
            break
        res2 = residuals(s2, r2, t2)
        if _percentile(sorted(res2), 0.5) > median:
            break
        scale, rotation, translation, res = s2, r2, t2, res2
    inliers = [i for i, r in enumerate(res) if r <= tol]
    ordered = sorted(res)
    median_rel = _percentile(ordered, 0.5) / spread_m
    p90_rel = _percentile(ordered, 0.9) / spread_m
    report.update({
        "scaleMPerUnit": scale,
        "inliers": len(inliers),
        "inlierFraction": round(len(inliers) / n, 4),
        "medianResidualM": round(_percentile(ordered, 0.5), 6),
        "p90ResidualM": round(_percentile(ordered, 0.9), 6),
        "maxResidualM": round(ordered[-1], 6),
        "medianResidualRel": round(median_rel, 6),
        "p90ResidualRel": round(p90_rel, 6),
    })
    if not (SCALE_MIN <= scale <= SCALE_MAX) or not math.isfinite(scale):
        report["reason"] = "fitted scale is outside the sane range"
        return report
    if len(inliers) / n < MIN_INLIER_FRACTION:
        report["reason"] = "too few camera centres agree with the alignment"
        return report
    if median_rel > MAX_MEDIAN_RESIDUAL_REL or p90_rel > MAX_P90_RESIDUAL_REL:
        report["reason"] = "camera-centre alignment residuals are too large"
        return report
    report["ok"] = True
    report["rotation"] = rotation
    report["translation"] = list(translation)
    return report
