// Połączenie wideo 1:1 (WebRTC, wzorzec „perfect negotiation”). Sygnalizacja idzie przez WebSocket pokoju.
export class Call {
  constructor({ send, polite, iceServers, localVideo, remoteVideo, onState }) {
    this.send = send;
    this.polite = polite;
    this.iceServers = iceServers || [];
    this.localVideo = localVideo;
    this.remoteVideo = remoteVideo;
    this.onState = onState || (() => {});
    this.pc = null;
    this.camTrack = null;
    this.screenTrack = null;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.queue = Promise.resolve();
    this.closed = false;
    this.mediaDone = false;
    this.stream = null;
    this.ready = this.startMedia();
  }

  async startMedia() {
    const tries = [
      { video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' }, audio: { echoCancellation: true, noiseSuppression: true } },
      { video: false, audio: true },
    ];
    for (const c of tries) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (e) { this.mediaError = e; }
    }
    if (this.closed) {
      // Ktoś wyszedł z pokoju, zanim przeglądarka dała kamerę: od razu ją wyłączamy.
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = new MediaStream();
      return this.stream;
    }
    if (!this.stream) {
      this.stream = new MediaStream();
      this.onState('no-media');
    }
    this.camTrack = this.stream.getVideoTracks()[0] || null;
    this.localVideo.srcObject = this.stream;
    this.localVideo.muted = true;
    this.localVideo.play().catch(() => {});
    this.mediaDone = true;
    // Połączenie mogło ruszyć wcześniej (np. czekaliśmy na zgodę na kamerę): dokładamy ścieżki teraz.
    if (this.pc) {
      if (this.stream.getTracks().length) this.attachTracks(this.pc); else this.addReceivers(this.pc);
    }
    return this.stream;
  }

  attachTracks(pc) {
    if (!this.stream) return;
    for (const t of this.stream.getTracks()) {
      if (!pc.getSenders().some((s) => s.track === t)) pc.addTrack(t, this.stream);
    }
    this.videoSender = pc.getSenders().find((x) => x.track?.kind === 'video') || this.videoSender;
  }

  addReceivers(pc) {
    // Bez kamery i mikrofonu i tak chcemy odbierać obraz drugiej osoby.
    if (pc.getTransceivers().length) return;
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });
  }

  /** Tworzy nowe połączenie (np. gdy druga osoba dołączyła albo odświeżyła stronę). */
  async reset() {
    if (this.closed) return;
    this.close(false);
    this.videoSender = null;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.makingOffer = false;
    this.ignoreOffer = false;
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send({ candidate }); };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription });
      } catch (e) { console.warn(e); } finally { this.makingOffer = false; }
    };
    pc.ontrack = ({ track, streams }) => {
      const s = streams[0] || new MediaStream([track]);
      if (this.remoteVideo.srcObject !== s) this.remoteVideo.srcObject = s;
      this.remoteVideo.play().catch((e) => { if (e.name === 'NotAllowedError') this.onState('needs-click'); });
    };
    pc.onconnectionstatechange = () => {
      this.onState(pc.connectionState);
      if (pc.connectionState === 'failed') pc.restartIce();
    };
    this.attachTracks(pc);
    if (this.screenTrack) this.replaceVideo(this.screenTrack);
    if (this.mediaDone && !this.stream.getTracks().length) this.addReceivers(pc);
  }

  /** Nowe połączenie w kolejce sygnałów (żeby nie wyprzedzić ofert w drodze). */
  restart() {
    this.queue = this.queue.then(() => this.reset()).catch((e) => console.warn('restart', e));
  }

  signal(data) {
    this.queue = this.queue.then(() => this.handle(data)).catch((e) => console.warn('signal', e));
  }

  async handle({ description, candidate, restart }) {
    if (restart) { await this.reset(); return; }
    if (!this.pc) await this.reset();
    const pc = this.pc;
    if (!pc) return;
    if (description) {
      const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription });
      }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); } catch (e) { if (!this.ignoreOffer) console.warn(e); }
    }
  }

  peerLeft() {
    this.close(false);
    this.remoteVideo.srcObject = null;
    this.onState('waiting');
  }

  close(stopMedia = true) {
    if (this.pc) { this.pc.onnegotiationneeded = null; this.pc.ontrack = null; this.pc.onicecandidate = null; this.pc.onconnectionstatechange = null; this.pc.close(); this.pc = null; }
    if (stopMedia) {
      this.closed = true;
      this.stream?.getTracks().forEach((t) => t.stop());
      this.screenTrack?.stop();
    }
  }

  // ---------- przyciski ----------

  toggleMic() {
    const t = this.stream?.getAudioTracks()[0];
    if (!t) return null;
    t.enabled = !t.enabled;
    return t.enabled;
  }

  toggleCam() {
    if (!this.camTrack) return null;
    this.camTrack.enabled = !this.camTrack.enabled;
    return this.camTrack.enabled;
  }

  replaceVideo(track) {
    if (!this.pc) return null;
    if (this.videoSender) return this.videoSender.replaceTrack(track);
    // Brak kamery: dokładamy ścieżkę wideo (np. udostępniany ekran) i negocjujemy od nowa.
    this.videoSender = this.pc.addTrack(track, this.stream || new MediaStream([track]));
    return null;
  }

  async shareScreen() {
    if (this.screenTrack) { this.stopShare(); return false; }
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    this.screenTrack = s.getVideoTracks()[0];
    this.screenTrack.onended = () => this.stopShare();
    await this.replaceVideo(this.screenTrack);
    this.localVideo.srcObject = new MediaStream([this.screenTrack]);
    return true;
  }

  stopShare() {
    if (!this.screenTrack) return;
    this.screenTrack.stop();
    this.screenTrack = null;
    if (this.camTrack) this.replaceVideo(this.camTrack);
    this.localVideo.srcObject = this.stream;
    this.onState('share-ended');
  }
}
