import com.comsol.model.*;
import com.comsol.model.util.*;
import java.io.PrintWriter;

/**
 * Model inspector: loads in.mph and dumps its structure to inspect.txt.
 * Use via the MCP run_code tool with mph_file set — the file is staged as in.mph.
 * Every section is fenced so one API hiccup doesn't lose the rest.
 * (Application Builder methods are not enumerable through the model API; if the
 * model is method-driven, the method inputs/tags must come from the GUI side.)
 */
public class Inspect {
  static PrintWriter out;

  interface Section { void print() throws Exception; }

  static void section(String title, Section s) {
    out.println("== " + title + " ==");
    try {
      s.print();
    } catch (Exception e) {
      out.println("  (failed: " + e.getMessage() + ")");
    }
  }

  public static void main(String[] args) throws Exception {
    Model m = ModelUtil.load("m", "in.mph");
    out = new PrintWriter("inspect.txt");

    section("parameters", () -> {
      for (String p : m.param().varnames()) {
        String d = "";
        try { d = m.param().descr(p); } catch (Exception ignored) {}
        out.println("  " + p + " = " + m.param().get(p) + (d.isEmpty() ? "" : "   // " + d));
      }
    });

    for (String c : m.component().tags()) {
      section("component " + c + " / geometries", () -> {
        for (String g : m.component(c).geom().tags()) {
          out.println("  " + g + " (" + m.component(c).geom(g).getSDim() + "D)");
        }
      });
      section("component " + c + " / physics", () -> {
        for (String ph : m.component(c).physics().tags()) {
          out.println("  " + ph + "  label=\"" + m.component(c).physics(ph).label() + "\"");
          for (String f : m.component(c).physics(ph).feature().tags()) {
            out.println("    - " + f + " (" + m.component(c).physics(ph).feature(f).getType() + ")");
          }
        }
      });
      section("component " + c + " / meshes", () -> {
        for (String me : m.component(c).mesh().tags()) out.println("  " + me);
      });
    }

    section("studies", () -> {
      for (String s : m.study().tags()) {
        out.print("  " + s + "  label=\"" + m.study(s).label() + "\" steps:");
        for (String f : m.study(s).feature().tags()) {
          out.print(" " + f + "(" + m.study(s).feature(f).getType() + ")");
        }
        out.println();
      }
    });

    section("datasets", () -> {
      for (String d : m.result().dataset().tags()) {
        out.println("  " + d + " (" + m.result().dataset(d).getType() + ")");
      }
    });

    section("tables", () -> {
      for (String t : m.result().table().tags()) out.println("  " + t);
    });

    out.close();
    System.out.println("inspection written to inspect.txt");
  }
}
