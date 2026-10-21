'use strict';

const PYTHON_VERSION='3.12.15',UV_VERSION='0.13.4',PBS_RELEASE='20261020';
const python={
 'darwin-arm64':{url:'https://github.com/astral-sh/python-build-standalone/releases/download/20261020/cpython-3.12.15%2B20261020-aarch64-apple-darwin-install_only_stripped.tar.gz',sha256:'e54a19fd9af218ddd4ed66bbec65f4e9062724ea848a0ddbd269e37765d9959e',bytes:25016814,platform:'aarch64-apple-darwin'},
 'linux-x64-glibc':{url:'https://github.com/astral-sh/python-build-standalone/releases/download/20261020/cpython-3.12.15%2B20261020-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz',sha256:'7d6ef1164fb94c4b60d913340610fc7e0ef8e3d1b705aa5628b299b08cbdd4b5',bytes:34479233,platform:'x86_64-manylinux_2_17'},
};
const uv={
 'darwin-arm64':{url:'https://github.com/astral-sh/uv/releases/download/0.13.4/uv-aarch64-apple-darwin.tar.gz',sha256:'e0b1d4743ce64c55d9f0f4a444afa6b81125680070ee04e853fcd0f6c1ebf8f1',bytes:14326193,entrypoint:'uv-aarch64-apple-darwin/uv'},
 'linux-x64-glibc':{url:'https://github.com/astral-sh/uv/releases/download/0.13.4/uv-x86_64-unknown-linux-gnu.tar.gz',sha256:'2b428396f12572d4429cf210ca234dd599a33b3af0958a4d5ed569d63e3f344f',bytes:16653835,entrypoint:'uv-x86_64-unknown-linux-gnu/uv'},
};
const asset=pin=>({url:pin.url,sha256:pin.sha256,format:'tar.gz',entrypoint:pin.entrypoint??'python/bin/python3.12'});
/** Inspectors retain exact runtime URLs and hashes before accepting a durable build. */
function pythonRuntimeAssets(){return Object.fromEntries(Object.entries(python).map(([target,pin])=>[target,asset(pin)]));}
/** Only these reviewed pins may execute on the producer; user declarations cannot replace them. */
function pythonBuildPins(target){
 if(!python[target]||!uv[target])throw new Error('Автоматическая поставка Python поддерживает macOS ARM64 и Linux x64 glibc.');
 return {python:{...asset(python[target]),bytes:python[target].bytes},uv:{...asset(uv[target]),bytes:uv[target].bytes},platform:python[target].platform};
}
module.exports={PYTHON_VERSION,UV_VERSION,PBS_RELEASE,pythonRuntimeAssets,pythonBuildPins};
