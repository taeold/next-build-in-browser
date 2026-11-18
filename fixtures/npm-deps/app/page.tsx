import { z } from "zod";
import { format, addDays } from "date-fns";
import { Package } from "lucide-react";
import { Clock } from "./components/Clock";
const Release = z.object({ name: z.string(), date: z.date() });
export default function Home() {
  const r = Release.parse({ name: "deps-app", date: addDays(new Date(2026, 10, 17), 1) });
  return (
    <main>
      <h1><Package size={20} /> {r.name}</h1>
      <p>Ships {format(r.date, "MMMM d, yyyy")}, built with npm packages installed in the browser.</p>
      <Clock />
    </main>
  );
}
