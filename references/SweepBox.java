import com.comsol.model.*;
import com.comsol.model.util.*;

/**
 * Reference pattern: parametric sweep inside ONE job. Rebuild geometry + mesh
 * per parameter value, re-run the study, append (L, freq) rows to one table,
 * save a single CSV.
 *
 * Physics: rigid air box (Lx = L, 0.8, 0.6 m), first eigenfrequencies vs L.
 * Analytic check: x-modes f = c·l/(2L); y/z modes constant (214.375, 285.833 Hz).
 */
public class SweepBox {
  public static Model run() {
    Model model = ModelUtil.create("Model");
    model.param().set("L", "1.0[m]");

    model.component().create("comp1", true);
    model.component("comp1").geom().create("geom1", 3);
    model.component("comp1").geom("geom1").create("blk1", "Block");
    model.component("comp1").geom("geom1").feature("blk1").set("size", new String[]{"L", "0.8", "0.6"});
    model.component("comp1").geom("geom1").run();

    model.component("comp1").physics().create("acpr", "PressureAcoustics", "geom1");
    model.component("comp1").physics("acpr").feature("fpam1").set("rho_mat", "userdef");
    model.component("comp1").physics("acpr").feature("fpam1").set("rho", "1.2[kg/m^3]");
    model.component("comp1").physics("acpr").feature("fpam1").set("c_mat", "userdef");
    model.component("comp1").physics("acpr").feature("fpam1").set("c", "343[m/s]");

    // See CONVENTIONS.md: create features directly; never automatic(false).
    model.component("comp1").mesh().create("mesh1");
    model.component("comp1").mesh("mesh1").create("ftet1", "FreeTet");
    model.component("comp1").mesh("mesh1").feature("size").set("hmax", "0.08");
    model.component("comp1").mesh("mesh1").run();

    model.study().create("std1");
    model.study("std1").create("eig", "Eigenfrequency");
    model.study("std1").feature("eig").set("mesh", new String[]{"geom1", "mesh1"});
    model.study("std1").feature("eig").set("neigsactive", true);
    model.study("std1").feature("eig").set("neigs", 6);
    model.study("std1").feature("eig").set("shiftactive", true);
    model.study("std1").feature("eig").set("shift", "10");

    // NOTE: datasets (dset1) only exist after a study has run — create the
    // evaluation and table after the first solve, not before.
    double[] lengths = {0.5, 0.75, 1.0, 1.25, 1.5};
    boolean first = true;
    for (double L : lengths) {
      model.param().set("L", L + "[m]");
      model.component("comp1").geom("geom1").run();
      model.component("comp1").mesh("mesh1").run();
      model.study("std1").run();
      if (first) {
        model.result().numerical().create("gev1", "EvalGlobal");
        model.result().numerical("gev1").set("data", "dset1");
        model.result().numerical("gev1").set("expr", new String[]{"L", "freq"});
        model.result().table().create("tbl1", "Table");
        model.result().numerical("gev1").set("table", "tbl1");
        model.result().numerical("gev1").setResult();
        first = false;
      } else {
        model.result().numerical("gev1").appendResult();
      }
    }
    model.result().table("tbl1").save("sweep.csv");

    return model;
  }

  public static void main(String[] args) {
    run();
  }
}
