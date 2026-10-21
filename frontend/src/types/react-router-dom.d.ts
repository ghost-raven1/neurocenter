/* Локальные типы для react-router-dom@5 (в пакете отсутствуют собственные типы). */

declare module 'react-router-dom' {
    import type { AnchorHTMLAttributes, ElementType, ReactElement, ReactNode } from 'react';

    export interface IRouterHistory {
        push(path: string): void;
        replace(path: string): void;
        block(prompt: string): () => void;
        location: IRouterLocation;
    }

    export interface IRouterLocation {
        pathname: string;
        search: string;
        hash: string;
    }

    export interface IRouterMatch<Params = Record<string, string>> {
        params: Params;
    }

    export function BrowserRouter(props: { children?: ReactNode }): ReactElement;
    export function Switch(props: { children?: ReactNode }): ReactElement;
    export function Redirect(props: { to: string }): ReactElement | null;
    export function Link(props:Omit<AnchorHTMLAttributes<HTMLAnchorElement>,'href'>&{to:string}):ReactElement;
    export function Route(props: {
        path?: string;
        exact?: boolean;
        component?: ElementType;
        render?: (props: IRouterMatch & IRouterLocation & { history: IRouterHistory }) => ReactNode;
        children?: ReactNode;
    }): ReactElement | null;
    export function useHistory(): IRouterHistory;
    export function useLocation(): IRouterLocation;
    export function useParams<Params = Record<string, string>>(): Params;
}
