// 认为输入为正数
function gcd(a: number, b: number): number {
    while (b !== 0) {
        const r = a % b;
        a = b;
        b = r;
    } return a;
}

/**
 * 分数类
 * 为了性能没有做过多的类型检查，使用时请确保传入的参数是整数
 */
export class Fraction {
    private _numerator = 0;
    private _denominator = 1;

    constructor(numerator = 0, denominator = 1) {
        this.set(numerator, denominator);
    }

    get numerator(): number {
        return this._numerator;
    }

    get denominator(): number {
        return this._denominator;
    }

    set(numerator: number, denominator = 1): this {
        if (denominator === 0) throw new RangeError("Denominator must not be zero");
        if (denominator < 0) {
            numerator = -numerator;
            denominator = -denominator;
        }
        const divisor = gcd(Math.abs(numerator), denominator);
        this._numerator = numerator / divisor;
        this._denominator = denominator / divisor;
        return this;
    }

    copyFrom(other: Fraction): this {
        this._numerator = other._numerator;
        this._denominator = other._denominator;
        return this;
    }

    clone(): Fraction {
        return new Fraction(this._numerator, this._denominator);
    }

    add(value: Fraction | number, denominator = 1): this {
        let numerator: number;
        if (typeof value === "number") {
            numerator = value;
        } else {
            numerator = value._numerator;
            denominator = value._denominator;
        }
        return this.set(
            this._numerator * denominator + numerator * this._denominator,
            this._denominator * denominator,
        );
    }

    sub(value: Fraction | number, denominator = 1): this {
        let numerator: number;
        if (typeof value === "number") {
            numerator = value;
        } else {
            numerator = value._numerator;
            denominator = value._denominator;
        }
        return this.set(
            this._numerator * denominator - numerator * this._denominator,
            this._denominator * denominator,
        );
    }

    mul(value: Fraction | number, denominator = 1): this {
        let numerator: number;
        if (typeof value === "number") {
            numerator = value;
        } else {
            numerator = value._numerator;
            denominator = value._denominator;
        }
        return this.set(
            this._numerator * numerator,
            this._denominator * denominator,
        );
    }

    div(value: Fraction | number, denominator = 1): this {
        let numerator: number;
        if (typeof value === "number") {
            numerator = value;
        } else {
            numerator = value._numerator;
            denominator = value._denominator;
        }
        if (numerator === 0) throw new RangeError("Cannot divide by zero");
        return this.set(
            this._numerator * denominator,
            this._denominator * numerator,
        );
    }

    divPow2(power = 1): this {
        if (this._numerator === 0) return this;
        while (power > 0 && this._numerator % 2 === 0) {
            this._numerator /= 2;
            power--;
        }
        this._denominator *= 2 ** power;
        return this;
    }

    compare(value: Fraction | number, denominator = 1): number {
        let numerator: number;
        if (typeof value === "number") {
            numerator = value;
        } else {
            numerator = value._numerator;
            denominator = value._denominator;
        }
        const difference = this._numerator * denominator - numerator * this._denominator;
        return difference < 0 ? -1 : difference > 0 ? 1 : 0;
    }

    equals(value: Fraction | number, denominator = 1): boolean {
        if (value instanceof Fraction) {
            return this._numerator === value._numerator
                && this._denominator === value._denominator;
        }
        return this._numerator * denominator === value * this._denominator;
    }

    isZero(): boolean {
        return this._numerator === 0;
    }

    toNumber(): number {
        return this._numerator / this._denominator;
    }

    toString(): string {
        return this._denominator === 1
            ? String(this._numerator)
            : `${this._numerator}/${this._denominator}`;
    }
}