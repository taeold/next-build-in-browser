"use client";
import useSWR from "swr";
import { Clock as Icon } from "lucide-react";
import clsx from "clsx";
const fetcher = () => Promise.resolve(new Date().toISOString());
export function Clock() {
  const { data } = useSWR("now", fetcher);
  return <p className={clsx("clock", { loaded: !!data })}><Icon size={14} /> {data ?? "loading"}</p>;
}
