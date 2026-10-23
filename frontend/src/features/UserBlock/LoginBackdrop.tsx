/** Decorative vector field; motion is optional and never carries information. */
export function LoginBackdrop(){
    return <div className="login-screen__background" aria-hidden="true">
        <div className="login-screen__glow login-screen__glow--first"/>
        <div className="login-screen__glow login-screen__glow--second"/>
        <svg className="login-screen__network" viewBox="0 0 1440 960" fill="none" preserveAspectRatio="xMidYMid slice">
            <defs><linearGradient id="login-orbit-stroke" x1="150" y1="100" x2="1250" y2="900" gradientUnits="userSpaceOnUse"><stop stopColor="#9db5cb" stopOpacity=".1"/><stop offset=".5" stopColor="#6e8fae" stopOpacity=".5"/><stop offset="1" stopColor="#9db5cb" stopOpacity=".05"/></linearGradient></defs>
            <g stroke="url(#login-orbit-stroke)" strokeWidth="1">
                <ellipse className="login-screen__orbit login-screen__orbit--one" cx="770" cy="480" rx="620" ry="230" transform="rotate(-32 770 480)"/>
                <ellipse className="login-screen__orbit login-screen__orbit--two" cx="770" cy="480" rx="570" ry="335" transform="rotate(28 770 480)"/>
                <ellipse cx="770" cy="480" rx="420" ry="570" transform="rotate(-24 770 480)"/>
                <path d="M0 730C290 930 380 90 820 170s410 570 680 310M-40 240c360-230 500 660 910 520s370-440 610-380"/>
            </g>
            <g className="login-screen__nodes" fill="#6e8fae">
                <circle cx="345" cy="183" r="4"/><circle cx="1115" cy="195" r="5"/><circle cx="1250" cy="570" r="3"/>
                <circle cx="410" cy="760" r="5"/><circle cx="880" cy="810" r="3"/><circle cx="195" cy="490" r="3"/>
            </g>
        </svg>
        <div className="login-screen__grain"/>
    </div>;
}
