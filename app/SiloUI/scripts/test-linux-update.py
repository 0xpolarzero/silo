#!/usr/bin/env python3
"""Real packaged AppImage update proof, with isolated XDG and loopback release fixture.

Both supplied AppImages must be built in an isolated checkout using the same
throwaway updater public key and http://127.0.0.1:18081/latest.json endpoint.
This external test never changes production configuration or installed user data.
"""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from selenium import webdriver
from selenium.common.exceptions import ElementNotInteractableException, StaleElementReferenceException, ElementClickInterceptedException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.options import BaseOptions
from selenium.webdriver.support.ui import WebDriverWait

parser=argparse.ArgumentParser()
parser.add_argument('--application', type=Path, required=True)
parser.add_argument('--update', type=Path, required=True)
parser.add_argument('--version', required=True)
parser.add_argument('--target', required=True)
parser.add_argument('--evidence', type=Path, required=True)
args=parser.parse_args()
args.evidence.mkdir(parents=True, exist_ok=True)
mode={'value':'corrupt'}
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*unused): pass
    def do_GET(self):
        if self.path=='/latest.json':
            signature=Path(str(args.update)+'.sig').read_text().strip()
            payload=json.dumps({'version':args.version,'notes':'Isolated real installer verification','platforms':{args.target:{'url':'http://127.0.0.1:18081/update.AppImage','signature':signature}}}).encode()
        elif self.path=='/update.AppImage':
            payload=args.update.read_bytes()
            if mode['value']=='corrupt': payload=payload[:-1]+bytes([payload[-1]^1])
        else:
            self.send_error(404);return
        self.send_response(200);self.send_header('Content-Length',str(len(payload)));self.end_headers()
        try:
            for offset in range(0,len(payload),1024*1024):
                self.wfile.write(payload[offset:offset+1024*1024])
                if self.path.endswith('.AppImage'): time.sleep(.005)
        except (BrokenPipeError, ConnectionResetError): pass

class Options(BaseOptions):
    _ignore_local_proxy=True
    @property
    def default_capabilities(self):return {}
    def to_capabilities(self):return {'tauri:options':{'application':str(args.application.resolve())}}

checks=[]
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def owned_processes(config):
    found=[]
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit():continue
        try:
            environment=(directory/'environ').read_bytes().split(b'\0')
            if f'XDG_CONFIG_HOME={config}'.encode() in environment and (directory/'comm').read_text().strip()=='silo-ui':found.append(int(directory.name))
        except (PermissionError,FileNotFoundError,ProcessLookupError):pass
    return found

server=ThreadingHTTPServer(('127.0.0.1',18081),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
browser=None
with tempfile.TemporaryDirectory(prefix='silo-real-update-') as temporary:
    environment=dict(os.environ)
    for name in ['CONFIG','DATA','CACHE']:
        path=Path(temporary,name.lower());path.mkdir();environment[f'XDG_{name}_HOME']=str(path)
    environment['APPIMAGE_EXTRACT_AND_RUN']='1'
    settings=Path(environment['XDG_CONFIG_HOME'],'org.silo.preview/settings.json');settings.parent.mkdir()
    settings.write_text(json.dumps({'schemaVersion':1,'settings':{'onboardingComplete':True,'launchAtLogin':False,'startWorkspacesAtLaunch':False,'reduceMotion':True},'onboardingDraft':None}))
    with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    with socket.socket() as probe:probe.bind(('127.0.0.1',0));native=probe.getsockname()[1]
    log=(args.evidence/'driver.log').open('w')
    driver=subprocess.Popen([shutil.which('tauri-driver'),'--port',str(port),'--native-port',str(native)],env=environment,stdout=log,stderr=subprocess.STDOUT)
    def connect():
        global browser
        browser=webdriver.Remote(f'http://127.0.0.1:{port}',options=Options())
        wait=WebDriverWait(browser,60,ignored_exceptions=(ElementNotInteractableException,StaleElementReferenceException,ElementClickInterceptedException))
        def main(_):
            for handle in browser.window_handles:
                browser.switch_to.window(handle)
                if 'native-status' not in browser.current_url:return True
            return False
        wait.until(main)
        def settings_ready(_):
            node=browser.find_element(By.ID,'application-nav-settings')
            if not node.is_displayed() or not node.is_enabled():return False
            node.click();return True
        wait.until(settings_ready)
        return wait
    def button(text):return browser.find_element(By.XPATH,f"//button[normalize-space()='{text}']")
    try:
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            try:
                with socket.create_connection(('127.0.0.1',native),timeout=1):break
            except OSError:time.sleep(.1)
        wait=connect()
        wait.until(lambda _:button('Check for updates').is_enabled())
        original=sha(args.application)
        button('Check for updates').click()
        wait.until(lambda _:button('Download update').is_enabled());button('Download update').click()
        wait.until(lambda _:browser.find_elements(By.CSS_SELECTOR,"[role='progressbar']"))
        wait.until(lambda _:button('Retry').is_enabled())
        assert sha(args.application)==original
        assert not browser.find_elements(By.XPATH,"//button[normalize-space()='Restart and update']")
        checks.append('Corrupted signed download rejected before installed AppImage changes')
        browser.save_screenshot(str(args.evidence/'invalid-signature.png'))
        mode['value']='valid';button('Retry').click()
        wait.until(lambda _:button('Restart and update').is_enabled())
        checks.append('Valid signed download reaches explicit install action')
        browser.save_screenshot(str(args.evidence/'ready.png'))
        button('Restart and update').click()
        deadline=time.monotonic()+90
        while time.monotonic()<deadline and sha(args.application)!=sha(args.update):time.sleep(.2)
        assert sha(args.application)==sha(args.update),'Installed AppImage must equal verified update bytes'
        checks.append('Real installer atomically replaces the AppImage with target version')
        time.sleep(2)
        assert owned_processes(environment['XDG_CONFIG_HOME']),'Updated app must restart'
        try:browser.quit()
        except Exception:pass
        browser=None
        for pid in owned_processes(environment['XDG_CONFIG_HOME']):os.kill(pid,signal.SIGTERM)
        time.sleep(.5)
        wait=connect()
        wait.until(lambda _:args.version in browser.find_element(By.CSS_SELECTOR,"section[aria-label='Updates']").text)
        assert json.loads(settings.read_text())['settings']['reduceMotion'] is True
        checks.append('Updated production app relaunches with target version and preserved settings')
        browser.save_screenshot(str(args.evidence/'updated.png'))
        (args.evidence/'result.json').write_text(json.dumps({'passed':True,'checks':checks},indent=2))
    except Exception:
        if browser:
            try:
                browser.save_screenshot(str(args.evidence/'failure.png'))
                (args.evidence/'failure.txt').write_text(browser.find_element(By.TAG_NAME,'body').text)
            except Exception:pass
        (args.evidence/'result.json').write_text(json.dumps({'passed':False,'checks':checks},indent=2))
        raise
    finally:
        if browser:
            try:browser.quit()
            except Exception:pass
        for pid in owned_processes(environment['XDG_CONFIG_HOME']):
            try:os.kill(pid,signal.SIGTERM)
            except ProcessLookupError:pass
        driver.terminate();driver.wait(timeout=10);log.close();server.shutdown()
for check in checks:print('PASS:',check)
