import { ReactNode } from "react";

export interface IBoundaryProps { children: ReactNode; reload: () => void; }