import com.comsol.model.*;
import com.comsol.model.util.*;

/**
 * Phase-0 proof for the autonomous-COMSOL pipeline: build a model entirely in
 * code, solve it on the cluster, export a CSV.
 *
 * Rigid-walled air box, 1.0 x 0.8 x 0.6 m, c = 343 m/s. Analytic eigenfrequencies:
 *   f(l,m,n) = (c/2) * sqrt((l/Lx)^2 + (m/Ly)^2 + (n/Lz)^2)
 * First few: 171.5, 214.4, 274.4, 285.8, 333.4, 343.0 Hz ...
 *
 * Run on the cluster:
 *   comsol compile HelloBox.java
 *   comsol batch -np $SLURM_CPUS_PER_TASK -inputfile HelloBox.class -nosave -batchlog batch.log
 */
public class HelloBox {
  public static Model run() {
    Model model = ModelUtil.create("Model");
    model.component().create("comp1", true);

    model.component("comp1").geom().create("geom1", 3);
    model.component("comp1").geom("geom1").create("blk1", "Block");
    model.component("comp1").geom("geom1").feature("blk1").set("size", new String[]{"1.0", "0.8", "0.6"});
    model.component("comp1").geom("geom1").run();

    // Pressure acoustics; walls default to sound-hard (rigid) — the analytic case.
    model.component("comp1").physics().create("acpr", "PressureAcoustics", "geom1");
    model.component("comp1").physics("acpr").feature("fpam1").set("rho_mat", "userdef");
    model.component("comp1").physics("acpr").feature("fpam1").set("rho", "1.2[kg/m^3]");
    model.component("comp1").physics("acpr").feature("fpam1").set("c_mat", "userdef");
    model.component("comp1").physics("acpr").feature("fpam1").set("c", "343[m/s]");

    // User-controlled mesh, the way GUI-exported Java does it: creating a
    // feature makes the sequence user-controlled implicitly. Never call
    // automatic(false) here — converting builds the physics-controlled sequence
    // first, which fails for eigenfrequency (no target frequency to size from).
    // hmax 0.06 m ≈ λ/10 at ~570 Hz.
    model.component("comp1").mesh().create("mesh1");
    model.component("comp1").mesh("mesh1").create("ftet1", "FreeTet");
    model.component("comp1").mesh("mesh1").feature("size").set("hmax", "0.06");
    model.component("comp1").mesh("mesh1").run();

    model.study().create("std1");
    model.study("std1").create("eig", "Eigenfrequency");
    // Study steps default to a physics-controlled mesh of their own (which fails
    // for eigenfrequency — no target frequency); point the step at our mesh.
    model.study("std1").feature("eig").set("mesh", new String[]{"geom1", "mesh1"});
    model.study("std1").feature("eig").set("neigsactive", true);
    model.study("std1").feature("eig").set("neigs", 12);
    model.study("std1").feature("eig").set("shiftactive", true);
    model.study("std1").feature("eig").set("shift", "150");
    model.study("std1").run();

    model.result().numerical().create("gev1", "EvalGlobal");
    model.result().numerical("gev1").set("data", "dset1");
    model.result().numerical("gev1").set("expr", new String[]{"freq"});
    model.result().table().create("tbl1", "Table");
    model.result().numerical("gev1").set("table", "tbl1");
    model.result().numerical("gev1").setResult();
    model.result().table("tbl1").save("eigenfrequencies.csv");

    return model;
  }

  public static void main(String[] args) {
    run();
  }
}
