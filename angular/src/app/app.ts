import { BreakpointObserver, LayoutModule } from '@angular/cdk/layout';
import { CommonModule } from '@angular/common';
import { Component, inject, OnInit, signal, effect } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, LayoutModule, CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  public mobileSize = signal(false);
  public sideMenuOpen = signal(false);
  protected readonly title = signal('birdnet-page');

  constructor(private breakpoint: BreakpointObserver) {
    effect(() => {
      const opened = this.sideMenuOpen();
      console.log(`Menu is now ${opened ? 'open' : 'closed'}`);
    });
  }


  ngOnInit() {
    console.log(this.breakpoint)
    this.breakpoint.observe(['(max-width: 700px)']).subscribe(result => {
      if (result.matches) {
        // Apply mobile styles
        // console.log('Mobile view');
        this.mobileSize.set(true);
        this.sideMenuOpen.set(false);
      } else {
        // console.log('Desktop view');
        this.mobileSize.set(false);
        this.sideMenuOpen.set(false);
      }
    });
  }

  public toggleSideMenu() {
    this.sideMenuOpen.update(value => !value);
  }
}
