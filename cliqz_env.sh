VERBOSE=false
CLOBBER=false

if [ -z "$LANG" ]; then
  LANG='en-US'
fi

while [[ $# > 0 ]]
do
  key="$1"

  case $key in
    -lang|--language)
    LANG="$2"
    shift # Consume additional argument
    ;;

    -v|--verbose)
    VERBOSE=true
    ;;

    --clobber)
    CLOBBER=true
    ;;

    *)
    echo "WARNING: Unknown option $key"
    ;;
  esac
  shift # Consume current argument
done

if [[ "$OSTYPE" == "linux-gnu" ]]; then
  IS_LINUX=true
  echo 'Linux OS detected'
elif [[ "$OSTYPE" == "darwin"* ]]; then
  IS_MAC_OS=true
  echo 'Mac OS detected'
elif [[ "$OSTYPE" == "cygwin" || "$OSTYPE" == "msys" ]]; then
  IS_WIN=true
  echo 'Windows OS detected'
else
  echo 'Unknow OS -`$OSTYPE`'
fi

if [ $IS_WIN ]; then
  MAKE=mozmake
else
  MAKE=make
fi

# TODO: Use MOZ_UPDATE_CHANNEL.
if [ -z $CQZ_RELEASE_CHANNEL ]; then
  export CQZ_RELEASE_CHANNEL=release
fi

export MOZCONFIG=browser/config/cliqz-release.mozconfig
SRC_BASE=mozilla-release
export MOZ_OBJDIR=../obj

# Mac specific paths
I386DIR=$MOZ_OBJDIR/i386
X86_64DIR=$MOZ_OBJDIR/x86_64

export MOZCONFIG=browser/config/cliqz-release.mozconfig
export CQZ_VERSION=$(awk -F "=" '/version/ {print $2}'\
  ./repack/distribution/distribution.ini | head -n1)
export CQZ_UI_LOCALE=`echo $LANG`
export MOZ_AUTOMATION_UPLOAD=1
export CQZ_BALROG_DOMAIN=balrog-admin.10e99.net
export BALROG_PATH=../build-tools/scripts/updates
export S3_BUCKET=repository.cliqz.com
export S3_UPLOAD_PATH=`echo dist/$CQZ_RELEASE_CHANNEL/$CQZ_VERSION/${LANG:0:2}`

OBJ_DIR=$MOZ_OBJDIR
if [ $IS_MAC_OS ]; then
  OBJ_DIR=$I386DIR
fi

ROOT_PATH=$PWD