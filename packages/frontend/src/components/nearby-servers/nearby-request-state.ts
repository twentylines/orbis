export class NearbyRequestState {
  private generation = 0;
  private selected = '';
  select(value: string) {
    this.selected = value;
    this.generation++;
  }
  begin() {
    return { generation: ++this.generation, interface: this.selected };
  }
  current(request: { generation: number; interface: string }) {
    return request.generation === this.generation && request.interface === this.selected;
  }
  selectedInterface() {
    return this.selected;
  }
}
