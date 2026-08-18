import com.comsol.model.*;
import com.comsol.model.util.*;

/**
 * Frame capture during a model build/solve — the "watch it happen" feature.
 *
 * Writes numbered PNGs into frames/ inside the job directory as the model is
 * constructed, so the run can be replayed afterwards (see `cluster frames`).
 * Two capture paths, because they need different COMSOL APIs:
 *   - geometry / mesh snapshots need NO solution: `geom(...).image().export()`
 *   - result plots need a dataset:  `result().export().create(tag, pgtag, "Image")`
 *
 * This file is a runnable demo AND the source of the reusable block below —
 * copy the "SNAPSHOT HELPERS" section into any generated model.
 *
 * Every property is set through put(), which reports a rejected property name
 * instead of aborting the run, so an API mismatch costs one log line rather
 * than a whole cluster job. Frames are best-effort: never let imaging break
 * the science.
 */
public class Snapshots {

  // ===================== SNAPSHOT HELPERS (copy this block) =====================

  static int frameNo = 0;
  static boolean framesEnabled = true;

  /** Set once, before the first shot. */
  static void framesInit() {
    new java.io.File("frames").mkdirs();
  }

  static String framePath(String label) {
    frameNo++;
    return String.format("frames/%04d_%s.png", frameNo, label.replaceAll("[^\\w.-]", "_"));
  }

  interface Setter { void set(String key, String value); }

  /** Set one property, tolerating (and reporting) a name this version rejects. */
  static void put(Setter s, String key, String value) {
    try {
      s.set(key, value);
    } catch (Exception e) {
      System.out.println("  frame property rejected: " + key + " (" + e.getMessage() + ")");
    }
  }

  /** Geometry snapshot — works before any solve exists. */
  static void shotGeom(Model m, String comp, String geom, String label) {
    if (!framesEnabled) return;
    String file = framePath(label);
    try {
      Setter s = (k, v) -> m.component(comp).geom(geom).image().set(k, v);
      put(s, "imagetype", "png");
      put(s, "pngfilename", file);
      put(s, "size", "manualweb");
      put(s, "unit", "px");
      put(s, "width", "900");
      put(s, "height", "700");
      put(s, "background", "color");
      put(s, "antialias", "on");
      m.component(comp).geom(geom).image().export();
      System.out.println("frame: " + file);
    } catch (Exception e) {
      System.out.println("frame FAILED (geometry " + label + "): " + e.getMessage());
    }
  }

  /** Mesh snapshot — after mesh().run(), still no solution needed. */
  static void shotMesh(Model m, String comp, String mesh, String label) {
    if (!framesEnabled) return;
    String file = framePath(label);
    try {
      Setter s = (k, v) -> m.component(comp).mesh(mesh).image().set(k, v);
      put(s, "imagetype", "png");
      put(s, "pngfilename", file);
      put(s, "size", "manualweb");
      put(s, "unit", "px");
      put(s, "width", "900");
      put(s, "height", "700");
      put(s, "background", "color");
      m.component(comp).mesh(mesh).image().export();
      System.out.println("frame: " + file);
    } catch (Exception e) {
      System.out.println("frame FAILED (mesh " + label + "): " + e.getMessage());
    }
  }

  /**
   * Result snapshot of solution index `level` (1-based) in dataset `dset`.
   * Creates the plot group and export node once, then reuses them.
   */
  static void shotResult(Model m, String dset, int level, String label) {
    if (!framesEnabled) return;
    String file = framePath(label);
    try {
      boolean fresh = true;
      for (String t : m.result().tags()) if (t.equals("pgSnap")) fresh = false;
      if (fresh) {
        m.result().create("pgSnap", "PlotGroup3D");
        m.result("pgSnap").set("data", dset);
        m.result("pgSnap").create("surfSnap", "Surface");
        m.result("pgSnap").feature("surfSnap").set("colortable", "Wave");
        m.result("pgSnap").feature("surfSnap").set("colorscalemode", "linearsymmetric");
        m.result().export().create("imgSnap", "pgSnap", "Image");
      }
      m.result("pgSnap").set("data", dset);
      m.result("pgSnap").setIndex("looplevel", level, 0);
      Setter s = (k, v) -> m.result().export("imgSnap").set(k, v);
      put(s, "plotgroup", "pgSnap");
      put(s, "imagetype", "png");
      put(s, "pngfilename", file);
      put(s, "size", "manualweb");
      put(s, "unit", "px");
      put(s, "width", "900");
      put(s, "height", "700");
      put(s, "background", "color");
      m.result().export("imgSnap").run();
      System.out.println("frame: " + file);
    } catch (Exception e) {
      System.out.println("frame FAILED (result " + label + "): " + e.getMessage());
    }
  }

  // =================== END SNAPSHOT HELPERS ===================

  /**
   * Demo: build a rigid air box step by step, capturing a frame after each
   * stage, solve it, then capture the first few mode shapes.
   * Doubles as the validation run for the imaging API on this cluster.
   */
  public static Model run() {
    framesInit();
    Model model = ModelUtil.create("Model");
    model.component().create("comp1", true);
    model.component("comp1").geom().create("geom1", 3);

    model.component("comp1").geom("geom1").create("blk1", "Block");
    model.component("comp1").geom("geom1").feature("blk1").set("size", new String[]{"1.0", "0.8", "0.6"});
    model.component("comp1").geom("geom1").run();
    shotGeom(model, "comp1", "geom1", "block");

    // a second feature, so the filmstrip shows the geometry actually changing
    model.component("comp1").geom("geom1").create("cyl1", "Cylinder");
    model.component("comp1").geom("geom1").feature("cyl1").set("pos", new String[]{"0.5", "0.4", "0"});
    model.component("comp1").geom("geom1").feature("cyl1").set("r", "0.15");
    model.component("comp1").geom("geom1").feature("cyl1").set("h", "0.6");
    model.component("comp1").geom("geom1").create("dif1", "Difference");
    model.component("comp1").geom("geom1").feature("dif1").selection("input").set("blk1");
    model.component("comp1").geom("geom1").feature("dif1").selection("input2").set("cyl1");
    model.component("comp1").geom("geom1").run();
    shotGeom(model, "comp1", "geom1", "minus_bore");

    model.component("comp1").physics().create("acpr", "PressureAcoustics", "geom1");
    model.component("comp1").physics("acpr").feature("fpam1").set("rho_mat", "userdef");
    model.component("comp1").physics("acpr").feature("fpam1").set("rho", "1.2[kg/m^3]");
    model.component("comp1").physics("acpr").feature("fpam1").set("c_mat", "userdef");
    model.component("comp1").physics("acpr").feature("fpam1").set("c", "343[m/s]");

    // See CONVENTIONS.md: create mesh features directly; never automatic(false).
    model.component("comp1").mesh().create("mesh1");
    model.component("comp1").mesh("mesh1").create("ftet1", "FreeTet");
    model.component("comp1").mesh("mesh1").feature("size").set("hmax", "0.06");
    model.component("comp1").mesh("mesh1").run();
    shotMesh(model, "comp1", "mesh1", "mesh");

    model.study().create("std1");
    model.study("std1").create("eig", "Eigenfrequency");
    model.study("std1").feature("eig").set("mesh", new String[]{"geom1", "mesh1"});
    model.study("std1").feature("eig").set("neigsactive", true);
    model.study("std1").feature("eig").set("neigs", 6);
    model.study("std1").feature("eig").set("shiftactive", true);
    model.study("std1").feature("eig").set("shift", "150");
    model.study("std1").run();

    for (int k = 1; k <= 6; k++) shotResult(model, "dset1", k, "mode" + k);

    model.result().numerical().create("gev1", "EvalGlobal");
    model.result().numerical("gev1").set("data", "dset1");
    model.result().numerical("gev1").set("expr", new String[]{"freq"});
    model.result().table().create("tbl1", "Table");
    model.result().numerical("gev1").set("table", "tbl1");
    model.result().numerical("gev1").setResult();
    model.result().table("tbl1").save("eigenfrequencies.csv");

    System.out.println("captured " + frameNo + " frames");
    return model;
  }

  public static void main(String[] args) {
    run();
  }
}
