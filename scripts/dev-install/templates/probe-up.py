import datetime
import hashlib
import http.client
import json
import os
import signal
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PORTAL_ORIGIN, IDENTITY_ORIGIN = os.environ["PORTAL_ORIGIN"], os.environ["IDENTITY_ORIGIN"]
DISCOVERY = "/realms/wasalx/.well-known/openid-configuration"
ALLOWED = {(PORTAL_ORIGIN, "/auth/login"): "portal_login",
           (IDENTITY_ORIGIN, "/realms/wasalx/protocol/openid-connect/auth"): "realm_auth"}
LIMIT = 600

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

class PortalDown(Exception):
    pass

def closed_alarm(signum, frame):
    raise PortalDown("deadline")

def probe(open_url, origin, path, label, deadline):
    url = origin+path
    category = "direct"
    for hop in range(3):
        budget=deadline-time.monotonic()
        if budget <= 0:
            raise PortalDown("deadline")
        started=time.monotonic()
        try:
            response=open_url(urllib.request.Request(url,headers={"User-Agent":"srv-check"}),timeout=min(20,budget))
        except urllib.error.HTTPError as error:
            response=error
        except (ssl.SSLError,urllib.error.URLError,OSError) as error:
            reason=getattr(error,"reason",error)
            if isinstance(error,ssl.SSLError) or isinstance(reason,ssl.SSLError):
                print(f"{label} http=0 ms={int((time.monotonic()-started)*1000)} bytes=0 redirect={category}",flush=True)
                raise PortalDown("tls") from None
            print(f"{label} http=0 ms={int((time.monotonic()-started)*1000)} bytes=0 redirect={category}",flush=True)
            return False
        with response:
            status=response.code
            location=response.headers.get("Location","")
            if status in (302,303,307):
                target=urllib.parse.urljoin(url,location) if location else ""
                split=urllib.parse.urlsplit(target)
                target_origin=f"{split.scheme}://{split.netloc}"
                cls=ALLOWED.get((target_origin,split.path)) if label=="APP" else None
                print(f"{label} http={status} ms={int((time.monotonic()-started)*1000)} bytes=0 redirect={cls or 'disallowed'}",flush=True)
                if not cls:
                    raise PortalDown("redirect")
                url,category=target,cls
                continue
            if 300<=status<400:
                print(f"{label} http={status} ms={int((time.monotonic()-started)*1000)} bytes=0 redirect=disallowed",flush=True)
                raise PortalDown("redirect")
            body=response.read(500000) if status==200 else b""
            print(f"{label} http={status} ms={int((time.monotonic()-started)*1000)} bytes={len(body)} redirect={category}",flush=True)
            if status==200 and label=="KEYCLOAK":
                try:
                    issuer=json.loads(body).get("issuer")
                except (ValueError,AttributeError):
                    issuer=None
                if issuer!=IDENTITY_ORIGIN+"/realms/wasalx":
                    print("issuer=mismatch",flush=True)
                    raise PortalDown("issuer")
            return status==200 and (label=="KEYCLOAK" or
                response.headers.get("Content-Type","").split(";",1)[0].strip().lower()=="text/html"
                and b"<html" in body[:3000].lower())
    raise PortalDown("redirect_limit")

def main(args=()):
    if args:
        if list(args)!=["--read-only"]:
            print("HOLD PROBE_ARGUMENTS",flush=True)
            return 75
        dropin=Path(os.environ["DROPIN"])
        try:
            actual=hashlib.sha256(dropin.read_bytes()).hexdigest()
        except OSError:
            actual=None
        if actual != os.environ["ORIGINAL_SHA"]:
            print("HOLD DEV_DROPIN_PIN",flush=True)
            return 75
        print("DEV_DROPIN_PIN=PASS",flush=True)
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),
             urllib.request.HTTPSHandler(context=ssl.create_default_context())).open
    deadline=time.monotonic()+LIMIT
    signal.signal(signal.SIGALRM,closed_alarm)
    signal.alarm(LIMIT)
    try:
        while time.monotonic()<deadline:
            began=time.monotonic()
            print("UTC "+datetime.datetime.now(datetime.timezone.utc).isoformat(),flush=True)
            if all([probe(opener,PORTAL_ORIGIN,"/app","APP",deadline),
                    probe(opener,IDENTITY_ORIGIN,DISCOVERY,"KEYCLOAK",deadline)]):
                print("PORTAL_HTTPS_READY=PASS",flush=True)
                return 0
            time.sleep(max(0,min(deadline-time.monotonic(),30-(time.monotonic()-began))))
    except (PortalDown,OSError,ValueError,urllib.error.URLError,http.client.HTTPException):
        pass
    finally:
        signal.alarm(0)
    print("PORTAL_DOWN",flush=True)
    return 75

if __name__=="__main__":
    sys.exit(main(sys.argv[1:]))
