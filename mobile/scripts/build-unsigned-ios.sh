#!/usr/bin/env bash
set -euo pipefail

mobile_root="$(cd "$(dirname "$0")/.." && pwd)"
build_root="${mobile_root}/build/unsigned-ios"
derived_data="${build_root}/derived-data"
output_dir="${build_root}/output"
version="$(node -p "require('${mobile_root}/app.json').expo.version")"

rm -rf "${build_root}"
mkdir -p "${output_dir}/Payload"

xcodebuild \
  -workspace "${mobile_root}/ios/Orca.xcworkspace" \
  -scheme Orca \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath "${derived_data}" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= \
  build

app_path="$(find "${derived_data}/Build/Products/Release-iphoneos" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [[ -z "${app_path}" ]]; then
  echo "Unsigned iOS build produced no .app bundle." >&2
  exit 1
fi

cp -R "${app_path}" "${output_dir}/Payload/"
rm -rf "${output_dir}/Payload/$(basename "${app_path}")/_CodeSignature"
(cd "${output_dir}" && zip -qry "orca-mobile-ios-${version}-unsigned.ipa" Payload)
rm -rf "${output_dir}/Payload"

codesign --verify "${app_path}" >/dev/null 2>&1 && {
  echo "Expected an unsigned iOS app, but codesign verification succeeded." >&2
  exit 1
}

echo "Created ${output_dir}/orca-mobile-ios-${version}-unsigned.ipa"
